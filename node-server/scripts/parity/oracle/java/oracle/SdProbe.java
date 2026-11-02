package oracle;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import org.hl7.fhir.model.Base;
import org.hl7.fhir.model.core.ElementDefinition;
import org.hl7.fhir.model.core.ElementDefinition.ElementDefinitionConstraintComponent;
import org.hl7.fhir.model.core.StructureDefinition;
import org.hl7.fhir.model.utilities.formats.FhirFormat;
import org.hl7.fhir.services.elementmodel.Element;
import org.hl7.fhir.services.elementmodel.Manager;
import org.hl7.fhir.services.fhirpath.ExpressionNode;
import org.hl7.fhir.services.fhirpath.FHIRPathEngine;
import org.hl7.fhir.services.validation.constants.ReferenceValidationPolicy;
import org.hl7.fhir.utilities.FhirPublication;
import org.hl7.fhir.validation.ValidationEngine;
import org.hl7.fhir.validation.instance.InstanceValidator;
import org.hl7.fhir.validation.instance.advisor.BasePolicyAdvisorForFullValidation;
import org.hl7.fhir.validation.instance.utils.ValidationContext;

/**
 * What a definition holds once validator_cli has loaded it, and what an invariant gives on an element of an instance: the
 * loaders rewrite definitions (StructureDefinitionHacker, PackageHackerRN), so the published file is not what the jar
 * evaluates.
 *
 *   SdProbe --tx-cache <dir> [--ig id#version]... [--url canonical --key constraint-key]... [--instance file --child name] [--expr fhirpath]...
 *
 * Prints, per --url, every constraint with that key on the loaded snapshot; per --expr, FHIRPathEngine.evaluate on the
 * named child of the instance (the call behind InstanceValidator.checkInvariant, l. 8878-8893) and convertToBoolean of it.
 */
public final class SdProbe {
  public static void main(String[] argv) throws Exception {
    ValidationEngine ve = new ValidationEngine.ValidationEngineBuilder()
        .withCanRunWithoutTerminologyServer(true)
        .withVersion("4.0.1")
        .withUserAgent("fhir/test-cases")
        .withTerminologyCachePath(arg(argv, "--tx-cache").get(0))
        .withTxServer("https://tx.fhir.org", null, FhirPublication.R4, false)
        .fromSource("hl7.fhir.r4.core#4.0.1");
    ve.setLanguage("en-US");
    ve.setLocale(Locale.US);
    ve.setPolicyAdvisor(new BasePolicyAdvisorForFullValidation(ReferenceValidationPolicy.IGNORE, null));
    for (String ig : arg(argv, "--ig")) ve.getIgLoader().loadIg(ve.getIgs(), ve.getBinaries(), ig, true);
    List<String> keys = arg(argv, "--key");
    for (String url : arg(argv, "--url")) {
      StructureDefinition sd = ve.getContext().fetchResource(StructureDefinition.class, url);
      System.out.println("SD " + url + " -> " + (sd == null ? "not found" : sd.getVersionedUrl() + " base " + sd.getBaseDefinition() + " package " + sd.getSourcePackage()));
      if (sd == null) continue;
      for (ElementDefinition ed : sd.getSnapshot().getElementList()) {
        for (ElementDefinitionConstraintComponent c : ed.getConstraintList()) {
          if (keys.contains(c.getKey())) System.out.println("  " + ed.getId() + " " + c.getKey() + " source=" + c.getSource() + " expression=" + c.getExpression());
        }
      }
    }
    if (!arg(argv, "--instance").isEmpty()) {
      InstanceValidator val = ve.getValidator(FhirFormat.JSON);
      val.validate(null, new ArrayList<>(), new ByteArrayInputStream("{\"resourceType\":\"Basic\"}".getBytes(StandardCharsets.UTF_8)), FhirFormat.JSON);
      FHIRPathEngine fpe = val.getFHIRPathEngine();
      byte[] bytes = Files.readAllBytes(new File(arg(argv, "--instance").get(0)).toPath());
      Element root = Manager.parseSingle(fpe.getWorker(), new ByteArrayInputStream(bytes), FhirFormat.JSON);
      InstanceValidator.setParents(root);
      Element focus = root.getNamedChild(arg(argv, "--child").get(0), false);
      System.out.println("FOCUS " + (focus == null ? "none" : focus.getName() + " : " + focus.fhirType()));
      for (String expr : arg(argv, "--expr")) {
        try {
          ExpressionNode node = fpe.parse(expr);
          ValidationContext vc = new ValidationContext(null, root);
          vc.setSliceRecords(new HashMap<>());
          List<Base> r = fpe.evaluate(vc, root, root, focus, node);
          List<String> shown = new ArrayList<>();
          for (Base b : r) shown.add(b.fhirType() + ":" + b.primitiveValue());
          System.out.println("EXPR " + expr + " => " + shown + " boolean=" + fpe.convertToBoolean(r));
        } catch (Throwable e) {
          System.out.println("EXPR " + expr + " threw " + e);
        }
      }
    }
    System.exit(0);
  }

  private static List<String> arg(String[] argv, String name) {
    List<String> out = new ArrayList<>();
    for (int i = 0; i + 1 < argv.length; i++) if (argv[i].equals(name)) out.add(argv[i + 1]);
    return out;
  }
}
