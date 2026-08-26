#!/usr/bin/python3
"""Certbot manual DNS-01 hook for the delegated Agent OS ACME zone."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import sys
import time
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone


API_ENDPOINT = "https://alidns.aliyuncs.com/"
API_VERSION = "2015-01-09"
CREDENTIALS_PATH = "/etc/agent-os/alidns-credentials.json"
ZONE = "acme.agent.zeroplus.fun"
RECORD_RR = "_acme-challenge"
RECORD_FQDN = f"{RECORD_RR}.{ZONE}"
EXPECTED_CERTBOT_DOMAIN = "agent.zeroplus.fun"


def percent(value: str) -> str:
    return urllib.parse.quote(value, safe="~-._")


def signed_url(action: str, parameters: dict[str, str], key_id: str, secret: str) -> str:
    common = {
        "AccessKeyId": key_id,
        "Action": action,
        "Format": "JSON",
        "SignatureMethod": "HMAC-SHA1",
        "SignatureNonce": str(uuid.uuid4()),
        "SignatureVersion": "1.0",
        "Timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "Version": API_VERSION,
        **parameters,
    }
    canonical = "&".join(
        f"{percent(str(key))}={percent(str(common[key]))}" for key in sorted(common)
    )
    to_sign = f"GET&%2F&{percent(canonical)}"
    signature = base64.b64encode(
        hmac.new(f"{secret}&".encode(), to_sign.encode(), hashlib.sha1).digest()
    ).decode()
    return f"{API_ENDPOINT}?{canonical}&Signature={percent(signature)}"


def call(action: str, parameters: dict[str, str], key_id: str, secret: str) -> dict:
    request = urllib.request.Request(
        signed_url(action, parameters, key_id, secret),
        headers={"User-Agent": "agent-os-certbot-alidns/1"},
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        value = json.load(response)
    if not isinstance(value, dict):
        raise RuntimeError(f"AliDNS {action} returned a non-object response")
    return value


def credentials() -> tuple[str, str]:
    stat = os.stat(CREDENTIALS_PATH, follow_symlinks=False)
    if stat.st_uid != 0 or stat.st_mode & 0o077:
        raise RuntimeError("AliDNS credentials must be root-owned and mode 0600")
    with open(CREDENTIALS_PATH, encoding="utf-8") as source:
        value = json.load(source)
    if set(value) != {"AccessKeyId", "AccessKeySecret"}:
        raise RuntimeError("AliDNS credentials have an unexpected shape")
    key_id, secret = value["AccessKeyId"], value["AccessKeySecret"]
    if not isinstance(key_id, str) or not isinstance(secret, str) or not key_id or not secret:
        raise RuntimeError("AliDNS credentials are invalid")
    return key_id, secret


def certbot_inputs() -> tuple[str, str]:
    domain = os.environ.get("CERTBOT_DOMAIN", "")
    validation = os.environ.get("CERTBOT_VALIDATION", "")
    if domain != EXPECTED_CERTBOT_DOMAIN:
        raise RuntimeError(f"refusing unexpected CERTBOT_DOMAIN: {domain!r}")
    if not validation or len(validation) > 1024 or any(char.isspace() for char in validation):
        raise RuntimeError("CERTBOT_VALIDATION is invalid")
    return domain, validation


def authenticate() -> None:
    _, validation = certbot_inputs()
    key_id, secret = credentials()
    created = call(
        "AddDomainRecord",
        {
            "DomainName": ZONE,
            "RR": RECORD_RR,
            "TTL": "600",
            "Type": "TXT",
            "Value": validation,
        },
        key_id,
        secret,
    )
    record_id = created.get("RecordId")
    if not isinstance(record_id, str) or not record_id:
        raise RuntimeError("AliDNS AddDomainRecord returned no RecordId")
    print(json.dumps({"recordId": record_id}, separators=(",", ":")), flush=True)
    time.sleep(int(os.environ.get("AGENT_OS_DNS_PROPAGATION_SECONDS", "30")))


def cleanup() -> None:
    raw = os.environ.get("CERTBOT_AUTH_OUTPUT", "")
    try:
        record_id = json.loads(raw)["recordId"]
    except (KeyError, TypeError, json.JSONDecodeError) as error:
        raise RuntimeError("CERTBOT_AUTH_OUTPUT is invalid") from error
    if not isinstance(record_id, str) or not record_id.isdigit():
        raise RuntimeError("CERTBOT_AUTH_OUTPUT recordId is invalid")
    key_id, secret = credentials()
    call("DeleteDomainRecord", {"RecordId": record_id}, key_id, secret)


def main() -> None:
    if os.geteuid() != 0:
        raise RuntimeError("AliDNS Certbot hook must run as root")
    if len(sys.argv) != 2 or sys.argv[1] not in {"auth", "cleanup"}:
        raise RuntimeError("usage: alidns-manual-hook.py <auth|cleanup>")
    if sys.argv[1] == "auth":
        authenticate()
    else:
        cleanup()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Agent OS AliDNS hook failed: {error}", file=sys.stderr)
        raise SystemExit(1)
