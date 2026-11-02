package oracle;

import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import javax.xml.parsers.DocumentBuilderFactory;
import org.hl7.fhir.model.Base;
import org.hl7.fhir.model.Property;
import org.hl7.fhir.model.utilities.formats.FhirFormat;
import org.hl7.fhir.services.elementmodel.Element;
import org.hl7.fhir.services.elementmodel.Manager;
import org.hl7.fhir.services.fhirpath.ExpressionNode;
import org.hl7.fhir.services.fhirpath.FHIRPathEngine;
import org.hl7.fhir.utilities.FhirPublication;
import org.hl7.fhir.validation.ValidationEngine;
import org.hl7.fhir.validation.instance.InstanceValidator;
import org.hl7.fhir.validation.instance.utils.ValidationContext;
import org.w3c.dom.Document;
import org.w3c.dom.Node;

/**
 * Evaluates the official FHIRPath suite the way validator_cli evaluates an invariant, and records the outcome per case.
 *
 * Engine: InstanceValidator.getFHIRPathEngine() of an R4 ValidationEngine, i.e. org.hl7.fhir.services.fhirpath.FHIRPathEngine
 * with ValidatorHostServices and the settings InstanceValidator's constructor gives it. Input: the element model
 * (Manager.parseSingle), as in validation. Call: fpe.parse + fpe.evaluate(valContext, resource, root, focus, node), the
 * call behind evaluateToBoolean in InstanceValidator.checkInvariant (l. 8878-8893).
 *
 *   FhirPathOracle --tc <fhir-test-cases> --tx-cache <dir> --out <jar.json>
 *
 * Per case, keyed "<group>#<index of the test in its group>":
 *  name, group, expr,
 *  parse: "ok" | "threw", check: "ok" | "threw" | "not-run" (the static check; checkInvariant does not run it),
 *  eval: "ok" | "threw" | "not-run", items: [{type, value | leaves}], error, frames (Java file:line, innermost first),
 *  predicate: FHIRPathEngine.convertToBoolean of the items when the test has predicate="true".
 */
public final class FhirPathOracle {
  public static void main(String[] argv) throws Exception {
    String tc = arg(argv, "--tc");
    String txCache = arg(argv, "--tx-cache");
    String out = arg(argv, "--out");
    ValidationEngine ve = new ValidationEngine.ValidationEngineBuilder()
        .withCanRunWithoutTerminologyServer(true)
        .withVersion("4.0.1")
        .withUserAgent("fhir/test-cases")
        .withTerminologyCachePath(txCache)
        .withTxServer("https://tx.fhir.org", null, FhirPublication.R4, false)
        .fromSource("hl7.fhir.r4.core#4.0.1");
    ve.setLanguage("en-US");
    ve.setLocale(Locale.US);
    InstanceValidator val = ve.getValidator(FhirFormat.JSON);
    // conformsTo() re-enters the validator, which needs the state a validate() call sets up (clearInternalState, l. 1115)
    val.validate(null, new ArrayList<>(), new ByteArrayInputStream("{\"resourceType\":\"Basic\"}".getBytes(StandardCharsets.UTF_8)), FhirFormat.JSON);
    FHIRPathEngine fpe = val.getFHIRPathEngine();

    Document doc = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(new File(tc, "r4/fhirpath/tests-fhir-r4.xml"));
    Map<String, Element> inputs = new HashMap<>();
    JsonObject results = new JsonObject();
    for (org.w3c.dom.Element g : children(doc.getDocumentElement(), "group")) {
      String group = g.getAttribute("name");
      boolean custom = "custom".equals(g.getAttribute("mode"));
      int index = -1;
      for (org.w3c.dom.Element t : children(g, "test")) {
        index++;
        JsonObject r = new JsonObject();
        results.add(group + "#" + index, r);
        r.addProperty("name", t.getAttribute("name"));
        r.addProperty("group", group);
        String expr = children(t, "expression").get(0).getTextContent();
        r.addProperty("expr", expr);
        if (custom) {
          r.addProperty("skip", "group mode=custom");
          continue;
        }
        runCase(fpe, tc, inputs, t, expr, r);
      }
    }
    String json = new GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create().toJson(results);
    Files.writeString(new File(out).toPath(), json, StandardCharsets.UTF_8);
    System.exit(0);
  }

  private static void runCase(FHIRPathEngine fpe, String tc, Map<String, Element> inputs, org.w3c.dom.Element t, String expr, JsonObject r) {
    ExpressionNode node;
    try {
      node = fpe.parse(expr);
      r.addProperty("parse", "ok");
    } catch (Throwable e) {
      r.addProperty("parse", "threw");
      r.addProperty("eval", "not-run");
      r.addProperty("check", "not-run");
      failure(r, e);
      return;
    }
    String input = t.getAttribute("inputfile");
    Element root = null;
    try {
      if (!input.isEmpty()) {
        root = inputs.get(input);
        if (root == null) {
          byte[] bytes = Files.readAllBytes(new File(tc, "r4/" + input).toPath());
          root = Manager.parseSingle(fpe.getWorker(), new ByteArrayInputStream(bytes), input.endsWith(".json") ? FhirFormat.JSON : FhirFormat.XML);
          InstanceValidator.setParents(root);
          inputs.put(input, root);
        }
      }
      if (root == null) fpe.check(null, null, null, node);
      else fpe.check(root, root.fhirType(), root.fhirType(), root.fhirType(), node);
      r.addProperty("check", "ok");
    } catch (Throwable e) {
      r.addProperty("check", "threw");
      r.addProperty("checkError", String.valueOf(e.getMessage()));
    }
    try {
      ValidationContext vc = root == null ? new ValidationContext((Object) null) : new ValidationContext(null, root);
      List<Base> result = new ArrayList<>();
      String context = t.getAttribute("context");
      if (!context.isEmpty() && root != null) {
        // the expression runs on each item of the context, the way an invariant runs on an element
        for (Base focus : fpe.evaluate(vc, root, root, root, fpe.parse(context))) result.addAll(fpe.evaluate(vc, root, root, focus, node));
      } else {
        result = fpe.evaluate(vc, root, root, root, node);
      }
      r.addProperty("eval", "ok");
      JsonArray items = new JsonArray();
      for (Base b : result) items.add(item(b));
      r.add("items", items);
      if ("true".equals(t.getAttribute("predicate"))) r.addProperty("predicate", fpe.convertToBoolean(result));
    } catch (Throwable e) {
      r.addProperty("eval", "threw");
      failure(r, e);
    }
  }

  private static JsonObject item(Base b) {
    JsonObject o = new JsonObject();
    o.addProperty("type", b.fhirType());
    if (b.isPrimitive()) o.addProperty("value", b.primitiveValue());
    else {
      List<String> leaves = new ArrayList<>();
      flatten(b, "", leaves);
      Collections.sort(leaves);
      JsonArray a = new JsonArray();
      leaves.forEach(a::add);
      o.add("leaves", a);
    }
    return o;
  }

  /** Every primitive below an item as "path=value". */
  private static void flatten(Base b, String path, List<String> out) {
    if (b.hasPrimitiveValue()) out.add(path + "=" + b.primitiveValue());
    for (Property p : b.getChildren()) {
      if (p.hasValues()) for (Base v : p.getValues()) flatten(v, path.isEmpty() ? p.getName() : path + "." + p.getName(), out);
    }
  }

  private static void failure(JsonObject r, Throwable e) {
    r.addProperty("error", e.getClass().getSimpleName() + ": " + e.getMessage());
    JsonArray frames = new JsonArray();
    // HL7 frames only: a JDK frame (List.get, String.substring) has no line and says nothing about the reason
    for (StackTraceElement f : e.getStackTrace()) {
      if (f.getClassName().startsWith("org.hl7.") && frames.size() < 4) frames.add(f.getFileName() + ":" + f.getLineNumber() + " " + f.getMethodName());
    }
    r.add("frames", frames);
  }

  private static List<org.w3c.dom.Element> children(org.w3c.dom.Element e, String name) {
    List<org.w3c.dom.Element> out = new ArrayList<>();
    for (Node n = e.getFirstChild(); n != null; n = n.getNextSibling()) {
      if (n instanceof org.w3c.dom.Element && name.equals(n.getNodeName())) out.add((org.w3c.dom.Element) n);
    }
    return out;
  }

  private static String arg(String[] argv, String key) {
    for (int i = 0; i + 1 < argv.length; i++) if (argv[i].equals(key)) return argv[i + 1];
    throw new IllegalArgumentException(key + " is required");
  }
}
