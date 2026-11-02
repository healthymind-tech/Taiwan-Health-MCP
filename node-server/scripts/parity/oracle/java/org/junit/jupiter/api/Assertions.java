package org.junit.jupiter.api;

import java.util.ArrayList;
import java.util.List;

/**
 * Shadows JUnit's Assertions (earlier on the classpath than validator_cli.jar) for SuiteOracle.
 *
 * The jar's own ValidationTests.test() is the oracle: it runs a manifest case exactly as the HL7 build does, and writes
 * each step's OperationOutcome before comparing it with the expected file. A mismatch would normally abort the case at
 * Assertions.fail, so a failing base step would hide the profile step. Here fail only records the message and returns,
 * which lets the unmodified test() run to the end.
 */
public final class Assertions {
  public static final List<String> FAILURES = new ArrayList<>();

  private Assertions() {}

  public static <V> V fail(String message) {
    FAILURES.add(message);
    return null;
  }

  public static void assertTrue(boolean condition) {
    if (!condition) FAILURES.add("assertTrue");
  }

  public static void assertTrue(boolean condition, String message) {
    if (!condition) FAILURES.add(message);
  }
}
