# ICD-10 Data Source

## ICD-10-CM/PCS
- **CM (Clinical Modification)**: used for diagnosis coding.
    - Source: the latest release from the US CMS (Centers for Medicare & Medicaid Services).
- **PCS (Procedure Coding System)**: used for procedure and surgical coding.
    - Source: as above.

## Taiwan NHI revisions
- **Source**: the National Health Insurance Administration, Ministry of Health and Welfare.
- **Handling of differences**:
    - Some codes carry specific rules or are non-reimbursable in Taiwan's NHI claim system; this system annotates them in the notes field where possible (the international standard still governs by default).
    - Chinese translations follow the NHIA-published Chinese edition of the International Classification of Diseases, 10th Revision.

## File format
The system reads an Excel file (`icd10cm_pcs_xxxx.xlsx`) under the `data/` directory for initialisation. That file must contain two sheets: `diagnosis` and `procedure`.
