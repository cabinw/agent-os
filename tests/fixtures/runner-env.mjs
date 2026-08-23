const visible = {
  runnerToken: process.env.AGENT_OS_RUNNER_TOKEN ?? null,
  humanToken: process.env.AGENT_OS_HUMAN_TOKEN ?? null,
  agentTokenMap: process.env.AGENT_OS_AGENT_TOKENS ?? null,
  runnerId: process.env.AGENT_OS_RUNNER_ID ?? null,
  lowercaseRunnerToken: process.env.agent_os_runner_token ?? null,
  scopedToken: process.env.AGENT_OS_TOKEN ?? null,
  scopedUrl: process.env.AGENT_OS_URL ?? null,
};

process.stdout.write(
  `${JSON.stringify({
    type: "result",
    text: JSON.stringify(visible),
    sessionId: "env-fixture-session",
  })}\n`,
);
