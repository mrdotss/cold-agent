import * as fc from "fast-check";

// Shared property-test defaults for the whole suite.
//
// Establish a DEFAULT of >= 100 iterations for every fast-check property so
// individual tests inherit thorough coverage without repeating `numRuns`.
// Any test may still override this locally by passing its own `numRuns`.
export const PROPERTY_TEST_RUNS = 100;

fc.configureGlobal({ numRuns: PROPERTY_TEST_RUNS });
