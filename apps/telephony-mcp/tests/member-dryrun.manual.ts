/**
 * Manual GC-1 rehearsal with real agent sessions and fake phone/platform adapters.
 * Reuses the same fixtures as meeting-mode.test.ts; never reads live config,
 * credentials, or the live call database, and never places a paid call.
 *
 * Run from apps/telephony-mcp: node --import tsx tests/member-dryrun.manual.ts [base-port]
 * In another session, long-poll the printed admin URL with as=<your member>.
 * Once that session is listening, type `ask eqstack` or `ask executive` here.
 */
import { rmSync } from "node:fs";
import { createInterface } from "node:readline";
import { startGateway } from "../src/gateway/gateway.js";
import {
  FakeAgentPlatform,
  FakeSecrets,
  FakeTelephony,
  fakeSecretValues,
  MemoryRecordingStore,
  meetingConfig,
  ScriptedLlm,
  tempStateDir,
} from "./helpers.js";

const basePort = Number(process.argv[2] ?? "19490");
if (!Number.isInteger(basePort) || basePort < 1024 || basePort > 65532) {
  throw new Error("base-port must be an integer from 1024 through 65532");
}

const dir = tempStateDir();
const platform = new FakeAgentPlatform();
const cfg = meetingConfig(
  { holdSec: 60 },
  {
    server: {
      publicBaseUrl: "https://gw.test.invalid",
      publicPort: basePort,
      adminPort: basePort + 1,
      toolsPort: basePort + 2,
    },
  },
);

const gateway = await startGateway(cfg, {
  secrets: new FakeSecrets(fakeSecretValues()),
  telephony: new FakeTelephony(),
  llm: new ScriptedLlm([]),
  recordings: new MemoryRecordingStore(),
  agentPlatform: platform,
});

const result = await gateway.service.startMeeting({
  to: "george",
  members: ["eqstack", "executive"],
  agenda: "No-call member rehearsal",
});
if (result.dryRun || !result.callId) throw new Error("fake meeting did not start");
const callId = result.callId;
const admin = `http://127.0.0.1:${basePort + 1}`;
console.log("FAKE meeting only: no Twilio or ElevenLabs request, no live state.");
console.log(`callId=${callId} admin=${admin}`);
console.log("Members: eqstack, executive. Poll with waitMs and your own as value.");
console.log("Type `ask eqstack`, `ask executive`, or `quit`.");

const questions = {
  eqstack: "What has your EQStack session verified in this rehearsal?",
  executive: "What can your executive session contribute to this meeting?",
} as const;
const input = createInterface({ input: process.stdin, output: process.stdout });
let asking = false;
let closing = false;

async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  input.close();
  try {
    await gateway.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

input.on("line", (line) => {
  const command = line.trim();
  if (command === "quit") {
    void close();
    return;
  }
  if (command !== "ask eqstack" && command !== "ask executive") {
    console.log("Use `ask eqstack`, `ask executive`, or `quit`.");
    input.prompt();
    return;
  }
  if (asking) {
    console.log("A question is already waiting for an answer.");
    input.prompt();
    return;
  }
  const member = command.slice("ask ".length) as keyof typeof questions;
  if (!gateway.service.isHostListening(callId, member)) {
    console.log(`${member} has no active/recent long-poll; start its poll first.`);
    input.prompt();
    return;
  }
  asking = true;
  void gateway.service
    .askConsult(callId, { agent: member, question: questions[member] })
    .then((answer) => {
      const row = gateway.service.store.listConsultQuestions(callId).at(-1);
      console.log(
        JSON.stringify({
          member,
          result: answer.status,
          stored: row?.status ?? null,
          deliveredVia: row?.deliveredVia ?? null,
        }),
      );
    })
    .catch((error: unknown) => console.error((error as Error).message))
    .finally(() => {
      asking = false;
      input.prompt();
    });
});
input.on("close", () => void close());
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
input.setPrompt("dryrun> ");
input.prompt();
