import { describeJournalContract } from "./journal-contract.js";
import { createMemoryJournalHarness } from "./memory.js";

describeJournalContract(createMemoryJournalHarness);
