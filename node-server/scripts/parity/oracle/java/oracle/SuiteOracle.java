package oracle;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.io.PrintStream;
import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;
import org.hl7.fhir.utilities.Utilities;
import org.hl7.fhir.utilities.tests.TestConfig;
import org.hl7.fhir.validation.tests.ValidationTests;
import org.junit.jupiter.api.Assertions;

/**
 * Runs the official validator test cases through org.hl7.fhir.validation.tests.ValidationTests as shipped in
 * validator_cli.jar and records what the jar produced for each step (never the expected file).
 *
 *   SuiteOracle --tc <fhir-test-cases> --tx-cache <dir> --out <results.jsonl> [--only a,b] [--timeout seconds] [--log file]
 *
 * One JSON line per step: {id, name, step, status: "ok" | "threw" | "timeout" | "not-run", outcome?, error?, frames?,
 * txRequests, ms}. id is the harness's run id: the case name, plus "#profile" for the profile step. Cases already in
 * --out are skipped (a timed-out one runs again), so a stopped batch resumes where it was.
 */
public final class SuiteOracle {
  private static final String[] STEPS = {"base", "profile"};

  public static void main(String[] argv) throws Exception {
    String tc = arg(argv, "--tc", null);
    String txCache = arg(argv, "--tx-cache", null);
    String out = arg(argv, "--out", null);
    String only = arg(argv, "--only", null);
    int timeout = Integer.parseInt(arg(argv, "--timeout", "900"));
    if (tc == null || txCache == null || out == null) throw new IllegalArgumentException("--tc, --tx-cache and --out are required");
    Set<String> wanted = only == null ? null : new HashSet<>(List.of(only.split(",")));

    TestConfig.getInstance().setFhirTestCasesDirectory(tc);
    TestConfig.getInstance().setTxCacheDirectory(txCache);

    Set<String> done = new HashSet<>();
    File outFile = new File(out);
    if (outFile.exists()) {
      for (String l : Files.readAllLines(outFile.toPath(), StandardCharsets.UTF_8)) {
        if (l.isBlank()) continue;
        JsonObject row = JsonParser.parseString(l).getAsJsonObject();
        if (!"timeout".equals(row.get("status").getAsString())) done.add(row.get("name").getAsString());
      }
    }

    // the runner's own chatter (each issue, per step timings) goes to a log, not into the results
    PrintStream realOut = System.out;
    PrintStream runnerLog = new PrintStream(new FileOutputStream(arg(argv, "--log", out + ".log"), true), true, StandardCharsets.UTF_8);
    AtomicInteger txRequests = new AtomicInteger();
    System.setOut(runnerLog);
    System.setErr(new PrintStream(new TxCountingStream(runnerLog, txRequests), true, StandardCharsets.UTF_8));

    ValidationTests.beforeClass();
    List<Object[]> cases = new ArrayList<>();
    for (Object[] c : ValidationTests.data()) {
      String id = (String) c[0];
      if (!id.startsWith("R4.")) continue; // R4B has its own prefix ("R4B."), every other version is out of scope
      String name = id.substring(3);
      if (wanted != null && !wanted.contains(name) && !wanted.contains(name + "#profile")) continue;
      if (!done.contains(name)) cases.add(c);
    }
    realOut.println("oracle: " + cases.size() + " cases to run, " + done.size() + " already recorded");

    Path outputDir = Path.of(Utilities.path("[tmp]", "validator", "validation-output"));
    Gson gson = new Gson();
    int n = 0;
    try (PrintWriter w = new PrintWriter(new FileOutputStream(outFile, true), true, StandardCharsets.UTF_8)) {
      for (Object[] c : cases) {
        String id = (String) c[0];
        JsonObject content = (JsonObject) c[1];
        String name = id.substring(3);
        String fileStem = id.replace("/", "-");
        for (String step : STEPS) Files.deleteIfExists(outputDir.resolve(fileStem + "-" + step + ".json"));
        Assertions.FAILURES.clear();
        txRequests.set(0);
        long t0 = System.currentTimeMillis();
        Throwable[] thrown = {null};
        Thread t = new Thread(() -> {
          try {
            new ValidationTests(id, content).test();
          } catch (Throwable e) {
            thrown[0] = e;
          }
        }, "case-" + n);
        t.setDaemon(true);
        t.start();
        t.join(timeout * 1000L);
        boolean timedOut = t.isAlive();
        long ms = System.currentTimeMillis() - t0;
        for (String step : STEPS) {
          if (step.equals("profile") && !content.has("profile")) continue;
          JsonObject row = new JsonObject();
          row.addProperty("id", step.equals("base") ? name : name + "#profile");
          row.addProperty("name", name);
          row.addProperty("step", step);
          row.addProperty("ms", ms);
          row.addProperty("txRequests", txRequests.get());
          Path f = outputDir.resolve(fileStem + "-" + step + ".json");
          if (Files.exists(f)) {
            row.addProperty("status", "ok");
            row.add("outcome", JsonParser.parseString(Files.readString(f, StandardCharsets.UTF_8)));
          } else {
            // no output and no exception: test() returned early (use-test=false)
            row.addProperty("status", timedOut ? "timeout" : thrown[0] != null ? "threw" : "not-run");
            if (thrown[0] != null) {
              row.addProperty("error", thrown[0].getClass().getName() + ": " + thrown[0].getMessage());
              JsonArray frames = new JsonArray();
              StackTraceElement[] st = thrown[0].getStackTrace();
              for (int i = 0; i < Math.min(st.length, 6); i++) frames.add(st[i].toString());
              row.add("frames", frames);
            }
          }
          w.println(gson.toJson(row));
        }
        n++;
        if (timedOut) realOut.println("oracle: timeout " + name);
        if (n % 25 == 0) realOut.println("oracle: " + n + "/" + cases.size());
      }
    }
    realOut.println("oracle: done " + n);
    System.exit(0); // timed-out case threads and the engine's pools would keep the JVM alive
  }

  private static String arg(String[] argv, String key, String def) {
    for (int i = 0; i + 1 < argv.length; i++) if (argv[i].equals(key)) return argv[i + 1];
    return def;
  }

  /** Passes bytes on to the log and counts CacheVerificationLogger's report of a request that missed the tx cache. */
  private static final class TxCountingStream extends OutputStream {
    private static final byte[] MARK = "Unexpected request to server".getBytes(StandardCharsets.UTF_8);
    private final OutputStream sink;
    private final AtomicInteger count;
    private int matched = 0;

    TxCountingStream(OutputStream sink, AtomicInteger count) {
      this.sink = sink;
      this.count = count;
    }

    @Override
    public void write(int b) throws java.io.IOException {
      sink.write(b);
      matched = (byte) b == MARK[matched] ? matched + 1 : ((byte) b == MARK[0] ? 1 : 0);
      if (matched == MARK.length) {
        count.incrementAndGet();
        matched = 0;
      }
    }
  }
}
