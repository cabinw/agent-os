const [prompt, resume = ""] = process.argv.slice(2);

if (prompt.endsWith("__BLOCK__")) {
  process.stdout.write(
    `${JSON.stringify({ type: "progress", label: `pid:${process.pid}` })}\n`,
  );
  setInterval(() => {}, 60_000);
} else if (prompt.endsWith("__FAIL__")) {
  process.stderr.write("fixture failed\n");
  process.exitCode = 7;
} else {
  const sessionId = resume || "fixture-session-1";
  process.stdout.write(
    `${JSON.stringify({ type: "delta", text: `stream:${prompt}` })}\n`,
  );
  process.stdout.write(`${JSON.stringify({ type: "progress", label: "working" })}\n`);
  process.stdout.write(
    `${JSON.stringify({ type: "usage", input: 3, output: 2, total: 5 })}\n`,
  );
  process.stdout.write(
    `${JSON.stringify({
      type: "result",
      text: `${resume ? `resumed:${resume}` : "fresh"}:${prompt}`,
      sessionId,
    })}\n`,
  );
}
