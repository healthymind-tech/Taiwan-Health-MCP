# The official HL7 FHIR validator (validator_cli) in its resident HTTP mode — the judge of fhir_validate_bundle /
# fhir_validate_resource (node-server/src/officialValidator.ts). One container per IG package (VALIDATOR_IG).
FROM eclipse-temurin:21-jre
ARG VALIDATOR_VERSION=7.0.1
ADD --checksum=sha256:1178b6a3a3fe98d9cd9545cadee505274967332466001d857e4d8bed7138a5bc \
    https://github.com/hapifhir/org.hl7.fhir.core/releases/download/${VALIDATOR_VERSION}/validator_cli.jar /opt/validator/validator_cli.jar
COPY entrypoint.sh /opt/validator/entrypoint.sh
RUN chmod 0555 /opt/validator/entrypoint.sh
WORKDIR /opt/validator
EXPOSE 8080
ENTRYPOINT ["/opt/validator/entrypoint.sh"]
