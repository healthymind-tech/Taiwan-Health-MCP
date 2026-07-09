import pytest

from loader.loaders.loinc_taiwan_seed import _load_mapping_csv, _load_ranges_csv


def test_mapping_csv_accepts_optional_specimen_and_unit(tmp_path):
    csv_path = tmp_path / "taiwan_mapping.csv"
    csv_path.write_text(
        "loinc_code,name_zh,common_name_zh\n"
        "2345-7,Glucose zh,Glucose common\n",
        encoding="utf-8",
    )

    assert _load_mapping_csv(csv_path) == [
        ("2345-7", "Glucose zh", "Glucose common", "", "")
    ]


def test_mapping_csv_strips_bom_and_header_spaces(tmp_path):
    csv_path = tmp_path / "taiwan_mapping.csv"
    csv_path.write_text(
        "\ufeffloinc_code, name_zh , common_name_zh , specimen_type , unit \n"
        "2345-7,Glucose zh,Glucose common,Ser/Plas,mg/dL\n",
        encoding="utf-8",
    )

    assert _load_mapping_csv(csv_path) == [
        ("2345-7", "Glucose zh", "Glucose common", "Ser/Plas", "mg/dL")
    ]


def test_mapping_csv_requires_loinc_code(tmp_path):
    csv_path = tmp_path / "taiwan_mapping.csv"
    csv_path.write_text("name_zh\nGlucose zh\n", encoding="utf-8")

    with pytest.raises(ValueError, match="loinc_code"):
        _load_mapping_csv(csv_path)


def test_ranges_csv_reports_missing_required_columns(tmp_path):
    csv_path = tmp_path / "lab_reference_ranges.csv"
    csv_path.write_text("loinc_code,age_min\n2345-7,18\n", encoding="utf-8")

    with pytest.raises(ValueError, match="range_high"):
        _load_ranges_csv(csv_path)
