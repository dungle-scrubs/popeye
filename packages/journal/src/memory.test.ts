import { describeJournalContract } from "./journal-contract.js";
import { createJournalMemoryHarness } from "./memory.js";

describeJournalContract(createJournalMemoryHarness);
