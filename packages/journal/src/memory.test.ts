import { describeJournalContract } from "./conformance/index.js";
import { createMemoryJournalHarness } from "./memory.js";

await describeJournalContract(createMemoryJournalHarness);
