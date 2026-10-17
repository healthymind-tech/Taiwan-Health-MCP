/**
 * Large example payloads for the admin MCP playground (see mcpToolExamples.ts).
 *
 * The TW Core resources were generated once from the installed TW Core 1.0.0 examples. The
 * grounding / completeness records and Bundles below were written by hand for this playground:
 * every patient, clinic, identifier and date is fictional (the national IDs only satisfy the
 * checksum). Kept as plain data so the examples are versioned with the tools and need no
 * database or filesystem access at runtime. They also serve as public test inputs
 * (src/grounding/syntheticExamples.test.ts).
 */

type Json = Record<string, unknown>;

/** TW Core 1.0.0 example Patient/pat-example (fhir.artifacts raw_json) */
export const TWCORE_PATIENT_EXAMPLE: Json = {
 "id": "pat-example",
 "meta": {
  "profile": [
   "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/Patient-twcore"
  ]
 },
 "name": [
  {
   "use": "official",
   "text": "陳加玲",
   "given": [
    "Chia Lin"
   ],
   "family": "Chen"
  }
 ],
 "text": {
  "div": "<div xmlns=\"http://www.w3.org/1999/xhtml\"><h3><b>病人基本資料-身分證字號及病歷號</b></h3><blockquote><p><b>識別碼型別</b>：National Person Identifier <span style=\"background: LightGoldenRodYellow; margin: 4px; border: 1px solid khaki\">（ <a href=\"http://terminology.hl7.org/CodeSystem/v2-0203\">Identifier Type Codes</a>#NNxxx <b>[extension: <a href=\"StructureDefinition-identifier-suffix.html\">Identifier Suffix</a>]：</b>TWN）</span><br/><b>身分證字號（official）</b>：A123456789 （http://www.moi.gov.tw）</p></blockquote><blockquote><p><b>識別碼型別</b>：Medical record number <span style=\"background: LightGoldenRodYellow; margin: 4px; border: 1px solid khaki\">（ <a href=\"http://terminology.hl7.org/CodeSystem/v2-0203\">Identifier Type Codes</a>#MR）</span><br/><b>病歷號（official）</b>：8862168 （https://www.tph.mohw.gov.tw）</p></blockquote><p><b>病人的紀錄（active）</b>：使用中</p><p><b>姓名（official）</b>：陳加玲 Chan, Chia Lin</p><p><b>性別</b>：女性</p><p><b>出生日期</b>：1990-01-01</p><p><b>年齡[extension: <a href=\"StructureDefinition-person-age.html\">person-age</a>]</b>：32</p><p><b>國籍[extension: <a href=\"http://hl7.org/fhir/StructureDefinition/patient-nationality\">patient-nationality</a>]</b>：<span style=\"background: LightGoldenRodYellow; margin: 4px; border: 1px solid khaki\"> （ <a href=\"https://terminology.hl7.org/CodeSystem-ISO3166Part1.html\">ISO3166Part1</a>#TW）</span></p><p><b>聯絡方式</b>：Phone <span style=\"background: LightGoldenRodYellow; margin: 4px; border: 1px solid khaki\">（ <a href=\"https://hl7.org/fhir/R4/valueset-contact-point-system.html\">ContactPointSystem</a>#phone）</span><br/><b>聯絡電話</b>：（Mobile）0911327999 <span style=\"background: LightGoldenRodYellow; margin: 4px; border: 1px solid khaki\">（ <a href=\"https://build.fhir.org/codesystem-contact-point-use.html\">ContactPointUse</a>#mobile）</span><br/><b>聯絡電話使用效期</b>：2022-07-31至2024-07-31</p><p><b>聯絡地址</b>：(103)臺北市大同區大有里19鄰承德路三段52巷6弄210號2樓B室<br/><b>郵遞區號（postalCode） [extension: <a href=\"StructureDefinition-tw-postal-code.html\">tw-postal-code</a>] </b>： <a href=\"CodeSystem-postal-code3-tw.html\">103</a><br/><b>縣/市（district）</b>：臺北市<br/><b>鄉/鎮/市/區（city）</b>：大同區<br/><b>村(里)（village） [extension: <a href=\"StructureDefinition-tw-village.html\">tw-village</a>] </b>：大有里<br/><b>鄰（neighborhood） [extension: <a href=\"StructureDefinition-tw-neighborhood.html\">tw-neighborhood</a>] </b>：19鄰<br/><b>路/街（line）</b>：承德路<br/><b>段(section) [extension: <a href=\"StructureDefinition-tw-section.html\">tw-section</a>] </b>：三段<br/><b>巷/衖（lane） [extension: <a href=\"StructureDefinition-tw-lane.html\">tw-lane</a>] </b>：52巷<br/><b>弄（alley） [extension: <a href=\"StructureDefinition-tw-alley.html\">tw-alley</a>] </b>：6弄<br/><b>號（number） [extension: <a href=\"StructureDefinition-tw-number.html\">tw-number</a>] </b>：210號<br/><b>樓（floor） [extension: <a href=\"StructureDefinition-tw-floor.html\">tw-floor</a>] </b>：2樓<br/><b>室（room） [extension: <a href=\"StructureDefinition-tw-room.html\">tw-room</a>] </b>：B室<br/><b>國家（country）</b>：臺灣<br/><br/></p><p><b>婚姻狀態</b>：unmarried <span style=\"background: LightGoldenRodYellow; margin: 4px; border: 1px solid khaki\">（ <a href=\"http://terminology.hl7.org/CodeSystem/v3-MaritalStatus\">臺灣婚姻狀態值集</a>#U）</span></p><p><b>聯絡人（official）</b>：李立偉 Li, Li Wei<br/><b>關係</b>：father <span style=\"background: LightGoldenRodYellow; margin: 4px; border: 1px solid khaki\">（ <a href=\"http://terminology.hl7.org/CodeSystem/v3-RoleCode\">PatientRelationshipType</a>#FTH）</span><br/><b>聯絡方式</b>：Phone <span style=\"background: LightGoldenRodYellow; margin: 4px; border: 1px solid khaki\">（ <a href=\"https://hl7.org/fhir/R4/valueset-contact-point-system.html\">ContactPointSystem</a>#phone）</span><br/><b>聯絡電話</b>：（Mobile）0917159753 <span style=\"background: LightGoldenRodYellow; margin: 4px; border: 1px solid khaki\">（ <a href=\"https://build.fhir.org/codesystem-contact-point-use.html\">ContactPointUse</a>#mobile）</span><br/><b>聯絡電話使用效期</b>：2022-07-31至2024-07-31</p><p><b>向病人說明健康狀態時所使用的語言</b>：中文</p><p><b>紀錄的保管機構</b>： <a href=\"Organization-org-hosp-example.html\">Organization/org-hosp-example</a> &quot;衛生福利部臺北醫院&quot;</p><p><b>病人影像</b>： <a href=\"https://2.bp.blogspot.com/-v3yEwItkXKQ/VaMN_1Nx6TI/AAAAAAAAvhM/zDXN_eZw_UE/s800/youngwoman_42.png\">patient.png</a><br/><img src=\"https://2.bp.blogspot.com/-v3yEwItkXKQ/VaMN_1Nx6TI/AAAAAAAAvhM/zDXN_eZw_UE/s800/youngwoman_42.png\" width=\"250px\"/></p></div>",
  "status": "generated"
 },
 "photo": [
  {
   "url": "patient.png",
   "contentType": "image/jpeg"
  }
 ],
 "active": true,
 "gender": "female",
 "address": [
  {
   "city": "大同區",
   "line": [
    "承德路"
   ],
   "text": "臺北市大同區大有里19鄰承德路三段52巷6弄210號2樓B室",
   "country": "TW",
   "district": "臺北市",
   "extension": [
    {
     "url": "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/tw-section",
     "valueString": "三段"
    },
    {
     "url": "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/tw-number",
     "valueString": "210號"
    },
    {
     "url": "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/tw-village",
     "valueString": "大有里"
    },
    {
     "url": "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/tw-neighborhood",
     "valueString": "19鄰"
    },
    {
     "url": "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/tw-lane",
     "valueString": "52巷"
    },
    {
     "url": "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/tw-alley",
     "valueString": "6弄"
    },
    {
     "url": "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/tw-floor",
     "valueString": "2樓"
    },
    {
     "url": "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/tw-room",
     "valueString": "B室"
    }
   ],
   "_postalCode": {
    "extension": [
     {
      "url": "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/tw-postal-code",
      "valueCodeableConcept": {
       "coding": [
        {
         "code": "103",
         "system": "https://twcore.mohw.gov.tw/ig/twcore/CodeSystem/postal-code3-tw"
        }
       ]
      }
     }
    ]
   }
  }
 ],
 "contact": [
  {
   "name": {
    "use": "official",
    "text": "李立偉",
    "given": [
     "Li Wei"
    ],
    "family": "Li"
   },
   "telecom": [
    {
     "use": "mobile",
     "value": "0917159753",
     "period": {
      "end": "2024-07-31",
      "start": "2022-07-31"
     },
     "system": "phone"
    }
   ],
   "relationship": [
    {
     "coding": [
      {
       "code": "FTH",
       "system": "http://terminology.hl7.org/CodeSystem/v3-RoleCode"
      }
     ]
    }
   ]
  }
 ],
 "telecom": [
  {
   "use": "mobile",
   "value": "0911327999",
   "period": {
    "end": "2024-07-31",
    "start": "2022-07-31"
   },
   "system": "phone"
  }
 ],
 "birthDate": "1990-01-01",
 "extension": [
  {
   "url": "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/person-age",
   "valueAge": {
    "code": "a",
    "value": 32,
    "system": "http://unitsofmeasure.org"
   }
  },
  {
   "url": "http://hl7.org/fhir/StructureDefinition/patient-nationality",
   "extension": [
    {
     "url": "code",
     "valueCodeableConcept": {
      "coding": [
       {
        "code": "TW",
        "system": "urn:iso:std:iso:3166"
       }
      ]
     }
    }
   ]
  }
 ],
 "identifier": [
  {
   "use": "official",
   "type": {
    "coding": [
     {
      "code": "NNxxx",
      "_code": {
       "extension": [
        {
         "url": "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/identifier-suffix",
         "extension": [
          {
           "url": "suffix",
           "valueString": "TWN"
          },
          {
           "url": "valueSet",
           "valueCanonical": "http://hl7.org/fhir/ValueSet/iso3166-1-3"
          }
         ]
        }
       ]
      },
      "system": "http://terminology.hl7.org/CodeSystem/v2-0203"
     }
    ]
   },
   "value": "A123456789",
   "system": "http://www.moi.gov.tw"
  },
  {
   "use": "official",
   "type": {
    "coding": [
     {
      "code": "MR",
      "system": "http://terminology.hl7.org/CodeSystem/v2-0203"
     }
    ]
   },
   "value": "8862168",
   "system": "https://www.tph.mohw.gov.tw"
  }
 ],
 "resourceType": "Patient",
 "communication": [
  {
   "language": {
    "coding": [
     {
      "code": "zh-TW",
      "system": "urn:ietf:bcp:47"
     }
    ]
   }
  }
 ],
 "maritalStatus": {
  "coding": [
   {
    "code": "U",
    "system": "http://terminology.hl7.org/CodeSystem/v3-MaritalStatus"
   }
  ]
 },
 "managingOrganization": {
  "reference": "Organization/org-hosp-example"
 }
};

/** TW Core 1.0.0 example Condition/con-example */
export const TWCORE_CONDITION_EXAMPLE: Json = {
 "id": "con-example",
 "code": {
  "text": "起因於潛在病的糖尿病，伴有低血糖，未伴有昏迷",
  "coding": [
   {
    "code": "E08.649",
    "system": "https://twcore.mohw.gov.tw/ig/twcore/CodeSystem/icd-10-cm-2021-tw"
   }
  ]
 },
 "meta": {
  "profile": [
   "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/Condition-twcore"
  ]
 },
 "text": {
  "div": "<div xmlns=\"http://www.w3.org/1999/xhtml\"><h3><b>病情、問題或診斷資料</b></h3><p><b>臨床狀態</b>：Remission <span style=\"background: LightGoldenRodYellow; margin: 4px; border: 1px solid khaki\">( <a href=\"http://terminology.hl7.org/CodeSystem/condition-clinical\">ConditionClinicalStatusCodes</a>#remission)</span></p><p><b>驗證狀態</b>：Confirmed <span style=\"background: LightGoldenRodYellow; margin: 4px; border: 1px solid khaki\">( <a href=\"http://terminology.hl7.org/CodeSystem/condition-ver-status\">ConditionVerificationStatus</a>#confirmed)</span></p><p><b>病情、問題或診斷分類</b>：Encounter Diagnosis <span style=\"background: LightGoldenRodYellow; margin: 4px; border: 1px solid khaki\">( <a href=\"http://terminology.hl7.org/CodeSystem/condition-category\">Condition Category Codes</a>#encounter-diagnosis)</span></p><p><b>嚴重程度</b>：Mild <span style=\"background: LightGoldenRodYellow; margin: 4px; border: 1px solid khaki\">( <a href=\"https://loinc.org/\">LOINC</a>#LA6752-5)</span></p><p><b>病情、問題或診斷識別</b>：起因於潛在病的糖尿病，伴有低血糖，未伴有昏迷 <span style=\"background: LightGoldenRodYellow; margin: 4px; border: 1px solid khaki\">( <a href=\"CodeSystem-icd-10-cm-2021-tw.html\">臺灣2021年中文版ICD-10-CM</a>#E08.649)</span></p><p><b>病人</b>：<a href=\"Patient-pat-example.html\">Patient/pat-example</a> &quot;陳加玲&quot;</p><p><b>實際日期</b>：2022-08-01 05:00:14-0500</p><p><b>緩解日期</b>：2022-08-01 06:00:14-0500</p><p><b>診斷者</b>：<a href=\"Practitioner-pra-dr-example.html\">Practitioner/pra-dr-example</a> &quot;王依昇&quot;</p></div>",
  "status": "generated"
 },
 "subject": {
  "reference": "Patient/pat-example"
 },
 "asserter": {
  "reference": "Practitioner/pra-dr-example"
 },
 "category": [
  {
   "coding": [
    {
     "code": "encounter-diagnosis",
     "system": "http://terminology.hl7.org/CodeSystem/condition-category"
    }
   ]
  }
 ],
 "severity": {
  "coding": [
   {
    "code": "LA6752-5",
    "system": "http://loinc.org"
   }
  ]
 },
 "resourceType": "Condition",
 "onsetDateTime": "2022-08-01T17:00:14+08:00",
 "clinicalStatus": {
  "coding": [
   {
    "code": "remission",
    "system": "http://terminology.hl7.org/CodeSystem/condition-clinical"
   }
  ]
 },
 "abatementDateTime": "2022-08-01T18:00:14+08:00",
 "verificationStatus": {
  "coding": [
   {
    "code": "confirmed",
    "system": "http://terminology.hl7.org/CodeSystem/condition-ver-status"
   }
  ]
 }
};

/** TW Core 1.0.0 example Bundle/bun-example (transaction: Patient + Medication) */
export const TWCORE_BUNDLE_EXAMPLE: Json = {
 "id": "bun-example",
 "meta": {
  "profile": [
   "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/Bundle-twcore"
  ]
 },
 "type": "transaction",
 "entry": [
  {
   "fullUrl": "https://twcore.mohw.gov.tw/ig/twcore/Patient/pat-example",
   "request": {
    "url": "Patient/pat-example",
    "method": "PUT"
   },
   "resource": {
    "id": "pat-example",
    "meta": {
     "profile": [
      "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/Patient-twcore"
     ]
    },
    "name": [
     {
      "use": "official",
      "text": "陳加玲",
      "given": [
       "Chia Lin"
      ],
      "family": "Chen"
     }
    ],
    "text": {
     "div": "<div xmlns=\"http://www.w3.org/1999/xhtml\"><a name=\"Patient_pat-example\"> </a><h3><b>病人基本資料-身分證字號及病歷號</b></h3><blockquote><p><b>識別碼型別</b>：National Person Identifier <span style=\"background: LightGoldenRodYellow; margin: 4px; border: 1px solid khaki\">（ <a href=\"http://terminology.hl7.org/CodeSystem/v2-0203\">Identifier Type Codes</a>#NNxxx <b>[extension: <a href=\"StructureDefinition-identifier-suffix.html\">Identifier Suffix</a>]：</b>TWN）</span><br/><b>身分證字號（official）</b>：A123456789 （http://www.moi.gov.tw）</p></blockquote><blockquote><p><b>識別碼型別</b>：Medical record number <span style=\"background: LightGoldenRodYellow; margin: 4px; border: 1px solid khaki\">（ <a href=\"http://terminology.hl7.org/CodeSystem/v2-0203\">Identifier Type Codes</a>#MR）</span><br/><b>病歷號（official）</b>：8862168 （https://www.tph.mohw.gov.tw）</p></blockquote><p><b>病人的紀錄（active）</b>：使用中</p><p><b>姓名（official）</b>：陳加玲 Chan, Chia Lin</p><p><b>性別</b>：女性</p><p><b>出生日期</b>：1990-01-01</p><p><b>年齡[extension: <a href=\"StructureDefinition-person-age.html\">person-age</a>]</b>：32</p><p><b>國籍[extension: <a href=\"http://hl7.org/fhir/StructureDefinition/patient-nationality\">patient-nationality</a>]</b>：<span style=\"background: LightGoldenRodYellow; margin: 4px; border: 1px solid khaki\"> （ <a href=\"https://terminology.hl7.org/CodeSystem-ISO3166Part1.html\">ISO3166Part1</a>#TW）</span></p><p><b>聯絡方式</b>：Phone <span style=\"background: LightGoldenRodYellow; margin: 4px; border: 1px solid khaki\">（ <a href=\"https://hl7.org/fhir/R4/valueset-contact-point-system.html\">ContactPointSystem</a>#phone）</span><br/><b>聯絡電話</b>：（Mobile）0911327999 <span style=\"background: LightGoldenRodYellow; margin: 4px; border: 1px solid khaki\">（ <a href=\"https://build.fhir.org/codesystem-contact-point-use.html\">ContactPointUse</a>#mobile）</span><br/><b>聯絡電話使用效期</b>：2022-07-31至2024-07-31</p><p><b>聯絡地址</b>：(103)臺北市大同區大有里19鄰承德路三段52巷6弄210號2樓B室<br/><b>郵遞區號（postalCode） [extension: <a href=\"StructureDefinition-tw-postal-code.html\">tw-postal-code</a>] </b>： <a href=\"CodeSystem-postal-code3-tw.html\">103</a><br/><b>縣/市（district）</b>：臺北市<br/><b>鄉/鎮/市/區（city）</b>：大同區<br/><b>村(里)（village） [extension: <a href=\"StructureDefinition-tw-village.html\">tw-village</a>] </b>：大有里<br/><b>鄰（neighborhood） [extension: <a href=\"StructureDefinition-tw-neighborhood.html\">tw-neighborhood</a>] </b>：19鄰<br/><b>路/街（line）</b>：承德路<br/><b>段(section) [extension: <a href=\"StructureDefinition-tw-section.html\">tw-section</a>] </b>：三段<br/><b>巷/衖（lane） [extension: <a href=\"StructureDefinition-tw-lane.html\">tw-lane</a>] </b>：52巷<br/><b>弄（alley） [extension: <a href=\"StructureDefinition-tw-alley.html\">tw-alley</a>] </b>：6弄<br/><b>號（number） [extension: <a href=\"StructureDefinition-tw-number.html\">tw-number</a>] </b>：210號<br/><b>樓（floor） [extension: <a href=\"StructureDefinition-tw-floor.html\">tw-floor</a>] </b>：2樓<br/><b>室（room） [extension: <a href=\"StructureDefinition-tw-room.html\">tw-room</a>] </b>：B室<br/><b>國家（country）</b>：臺灣<br/><br/></p><p><b>婚姻狀態</b>：unmarried <span style=\"background: LightGoldenRodYellow; margin: 4px; border: 1px solid khaki\">（ <a href=\"http://terminology.hl7.org/CodeSystem/v3-MaritalStatus\">臺灣婚姻狀態值集</a>#U）</span></p><p><b>聯絡人（official）</b>：李立偉 Li, Li Wei<br/><b>關係</b>：father <span style=\"background: LightGoldenRodYellow; margin: 4px; border: 1px solid khaki\">（ <a href=\"http://terminology.hl7.org/CodeSystem/v3-RoleCode\">PatientRelationshipType</a>#FTH）</span><br/><b>聯絡方式</b>：Phone <span style=\"background: LightGoldenRodYellow; margin: 4px; border: 1px solid khaki\">（ <a href=\"https://hl7.org/fhir/R4/valueset-contact-point-system.html\">ContactPointSystem</a>#phone）</span><br/><b>聯絡電話</b>：（Mobile）0917159753 <span style=\"background: LightGoldenRodYellow; margin: 4px; border: 1px solid khaki\">（ <a href=\"https://build.fhir.org/codesystem-contact-point-use.html\">ContactPointUse</a>#mobile）</span><br/><b>聯絡電話使用效期</b>：2022-07-31至2024-07-31</p><p><b>向病人說明健康狀態時所使用的語言</b>：中文</p><p><b>紀錄的保管機構</b>： <a href=\"Organization-org-hosp-example.html\">Organization/org-hosp-example</a> &quot;衛生福利部臺北醫院&quot;</p><p><b>病人影像</b>： <a href=\"https://2.bp.blogspot.com/-v3yEwItkXKQ/VaMN_1Nx6TI/AAAAAAAAvhM/zDXN_eZw_UE/s800/youngwoman_42.png\">patient.png</a><br/><img src=\"https://2.bp.blogspot.com/-v3yEwItkXKQ/VaMN_1Nx6TI/AAAAAAAAvhM/zDXN_eZw_UE/s800/youngwoman_42.png\" width=\"250px\"/></p></div>",
     "status": "generated"
    },
    "photo": [
     {
      "url": "patient.png",
      "contentType": "image/jpeg"
     }
    ],
    "active": true,
    "gender": "female",
    "address": [
     {
      "city": "大同區",
      "line": [
       "承德路"
      ],
      "text": "臺北市大同區大有里19鄰承德路三段52巷6弄210號2樓B室",
      "country": "TW",
      "district": "臺北市",
      "extension": [
       {
        "url": "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/tw-section",
        "valueString": "三段"
       },
       {
        "url": "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/tw-number",
        "valueString": "210號"
       },
       {
        "url": "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/tw-village",
        "valueString": "大有里"
       },
       {
        "url": "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/tw-neighborhood",
        "valueString": "19鄰"
       },
       {
        "url": "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/tw-lane",
        "valueString": "52巷"
       },
       {
        "url": "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/tw-alley",
        "valueString": "6弄"
       },
       {
        "url": "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/tw-floor",
        "valueString": "2樓"
       },
       {
        "url": "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/tw-room",
        "valueString": "B室"
       }
      ],
      "_postalCode": {
       "extension": [
        {
         "url": "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/tw-postal-code",
         "valueCodeableConcept": {
          "coding": [
           {
            "code": "103",
            "system": "https://twcore.mohw.gov.tw/ig/twcore/CodeSystem/postal-code3-tw"
           }
          ]
         }
        }
       ]
      }
     }
    ],
    "contact": [
     {
      "name": {
       "use": "official",
       "text": "李立偉",
       "given": [
        "Li Wei"
       ],
       "family": "Li"
      },
      "telecom": [
       {
        "use": "mobile",
        "value": "0917159753",
        "period": {
         "end": "2024-07-31",
         "start": "2022-07-31"
        },
        "system": "phone"
       }
      ],
      "relationship": [
       {
        "coding": [
         {
          "code": "FTH",
          "system": "http://terminology.hl7.org/CodeSystem/v3-RoleCode"
         }
        ]
       }
      ]
     }
    ],
    "telecom": [
     {
      "use": "mobile",
      "value": "0911327999",
      "period": {
       "end": "2024-07-31",
       "start": "2022-07-31"
      },
      "system": "phone"
     }
    ],
    "birthDate": "1990-01-01",
    "extension": [
     {
      "url": "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/person-age",
      "valueAge": {
       "code": "a",
       "value": 32,
       "system": "http://unitsofmeasure.org"
      }
     },
     {
      "url": "http://hl7.org/fhir/StructureDefinition/patient-nationality",
      "extension": [
       {
        "url": "code",
        "valueCodeableConcept": {
         "coding": [
          {
           "code": "TW",
           "system": "urn:iso:std:iso:3166"
          }
         ]
        }
       }
      ]
     }
    ],
    "identifier": [
     {
      "use": "official",
      "type": {
       "coding": [
        {
         "code": "NNxxx",
         "_code": {
          "extension": [
           {
            "url": "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/identifier-suffix",
            "extension": [
             {
              "url": "suffix",
              "valueString": "TWN"
             },
             {
              "url": "valueSet",
              "valueCanonical": "http://hl7.org/fhir/ValueSet/iso3166-1-3"
             }
            ]
           }
          ]
         },
         "system": "http://terminology.hl7.org/CodeSystem/v2-0203"
        }
       ]
      },
      "value": "A123456789",
      "system": "http://www.moi.gov.tw"
     },
     {
      "use": "official",
      "type": {
       "coding": [
        {
         "code": "MR",
         "system": "http://terminology.hl7.org/CodeSystem/v2-0203"
        }
       ]
      },
      "value": "8862168",
      "system": "https://www.tph.mohw.gov.tw"
     }
    ],
    "resourceType": "Patient",
    "communication": [
     {
      "language": {
       "coding": [
        {
         "code": "zh-TW",
         "system": "urn:ietf:bcp:47"
        }
       ]
      }
     }
    ],
    "maritalStatus": {
     "coding": [
      {
       "code": "U",
       "system": "http://terminology.hl7.org/CodeSystem/v3-MaritalStatus"
      }
     ]
    },
    "managingOrganization": {
     "reference": "Organization/org-hosp-example"
    }
   }
  },
  {
   "fullUrl": "https://twcore.mohw.gov.tw/ig/twcore/Medication/med-example",
   "request": {
    "url": "Medication/med-example",
    "method": "PUT"
   },
   "resource": {
    "id": "med-example",
    "code": {
     "text": "阿立批挫",
     "coding": [
      {
       "code": "衛署藥輸字第025485號",
       "system": "https://twcore.mohw.gov.tw/ig/twcore/CodeSystem/medication-fda-tw",
       "display": "阿立批挫"
      }
     ]
    },
    "form": {
     "text": "粉",
     "coding": [
      {
       "code": "POWD",
       "system": "http://terminology.hl7.org/CodeSystem/v3-orderableDrugForm"
      }
     ]
    },
    "meta": {
     "profile": [
      "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/Medication-twcore"
     ]
    },
    "text": {
     "div": "<div xmlns=\"http://www.w3.org/1999/xhtml\"><a name=\"Medication_med-example\"> </a><h3><b>藥品的詳細資料</b></h3><p><b>藥品</b>：阿立批挫 <span style=\"background: LightGoldenRodYellow; margin: 4px; border: 1px solid khaki\">( <a href=\"CodeSystem-medication-fda-tw.html\">臺灣藥品及醫療器材代碼值集</a>#衛署藥輸字第025485號)</span></p><p><b>藥品劑型</b>：粉 <span style=\"background: LightGoldenRodYellow; margin: 4px; border: 1px solid khaki\">( <a href=\"http://terminology.hl7.org/CodeSystem/v3-orderableDrugForm\">Orderable Drug Form</a>#POWD)</span></p></div>",
     "status": "generated"
    },
    "resourceType": "Medication"
   }
  }
 ],
 "timestamp": "2023-12-11T12:00:00.000Z",
 "identifier": {
  "value": "01014857930415100059403",
  "system": "https://www.tph.mohw.gov.tw"
 },
 "resourceType": "Bundle"
};

/** Fictional ENT outpatient record + TW Core Bundle with a full evidence map (strict mode; expected: valid, no errors) */
export const GROUNDING_VALID_INPUT: Json = {
 "bundle": {
  "resourceType": "Bundle",
  "meta": {
   "profile": [
    "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/Bundle-twcore"
   ]
  },
  "type": "collection",
  "timestamp": "2026-09-16T15:00:00+08:00",
  "entry": [
   {
    "fullUrl": "urn:uuid:5b0e7c1a-3d24-4f86-9a1e-0c7d2e4f6a11",
    "resource": {
     "resourceType": "Patient",
     "meta": {
      "profile": [
       "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/Patient-twcore"
      ]
     },
     "identifier": [
      {
       "use": "official",
       "type": {
        "coding": [
         {
          "system": "http://terminology.hl7.org/CodeSystem/v2-0203",
          "code": "NNxxx"
         }
        ]
       },
       "system": "http://www.moi.gov.tw",
       "value": "E103572464"
      },
      {
       "use": "official",
       "type": {
        "coding": [
         {
          "system": "http://terminology.hl7.org/CodeSystem/v2-0203",
          "code": "MR"
         }
        ]
       },
       "system": "https://www.renxin-hosp.example.org.tw/mrn",
       "value": "R0418827"
      }
     ],
     "active": true,
     "name": [
      {
       "use": "official",
       "text": "黃志豪",
       "family": "黃",
       "given": [
        "志豪"
       ]
      }
     ],
     "gender": "male",
     "birthDate": "1981-11-03"
    }
   },
   {
    "fullUrl": "urn:uuid:5b0e7c1a-3d24-4f86-9a1e-0c7d2e4f6a12",
    "resource": {
     "resourceType": "Encounter",
     "meta": {
      "profile": [
       "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/Encounter-twcore"
      ]
     },
     "status": "finished",
     "class": {
      "system": "http://terminology.hl7.org/CodeSystem/v3-ActCode",
      "code": "AMB",
      "display": "ambulatory"
     },
     "serviceType": {
      "coding": [
       {
        "system": "http://snomed.info/sct",
        "code": "418960008",
        "display": "Otolaryngology"
       }
      ],
      "text": "耳鼻喉科"
     },
     "subject": {
      "reference": "urn:uuid:5b0e7c1a-3d24-4f86-9a1e-0c7d2e4f6a11"
     },
     "period": {
      "start": "2026-09-16T14:10:00+08:00"
     }
    }
   },
   {
    "fullUrl": "urn:uuid:5b0e7c1a-3d24-4f86-9a1e-0c7d2e4f6a13",
    "resource": {
     "resourceType": "Condition",
     "meta": {
      "profile": [
       "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/Condition-twcore"
      ]
     },
     "clinicalStatus": {
      "coding": [
       {
        "system": "http://terminology.hl7.org/CodeSystem/condition-clinical",
        "code": "active",
        "display": "Active"
       }
      ]
     },
     "verificationStatus": {
      "coding": [
       {
        "system": "http://terminology.hl7.org/CodeSystem/condition-ver-status",
        "code": "confirmed",
        "display": "Confirmed"
       }
      ]
     },
     "category": [
      {
       "coding": [
        {
         "system": "http://terminology.hl7.org/CodeSystem/condition-category",
         "code": "encounter-diagnosis",
         "display": "Encounter Diagnosis"
        }
       ]
      }
     ],
     "code": {
      "coding": [
       {
        "system": "http://hl7.org/fhir/sid/icd-10-cm",
        "code": "J01.90",
        "display": "Acute sinusitis, unspecified"
       }
      ],
      "text": "Acute sinusitis 急性鼻竇炎"
     },
     "subject": {
      "reference": "urn:uuid:5b0e7c1a-3d24-4f86-9a1e-0c7d2e4f6a11"
     },
     "encounter": {
      "reference": "urn:uuid:5b0e7c1a-3d24-4f86-9a1e-0c7d2e4f6a12"
     },
     "recordedDate": "2026-09-16"
    }
   },
   {
    "fullUrl": "urn:uuid:5b0e7c1a-3d24-4f86-9a1e-0c7d2e4f6a14",
    "resource": {
     "resourceType": "Observation",
     "meta": {
      "profile": [
       "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/Observation-heart-rate-twcore"
      ]
     },
     "status": "final",
     "category": [
      {
       "coding": [
        {
         "system": "http://terminology.hl7.org/CodeSystem/observation-category",
         "code": "vital-signs",
         "display": "Vital Signs"
        }
       ]
      }
     ],
     "code": {
      "coding": [
       {
        "system": "http://loinc.org",
        "code": "8867-4",
        "display": "Heart rate"
       }
      ],
      "text": "心跳 HR"
     },
     "subject": {
      "reference": "urn:uuid:5b0e7c1a-3d24-4f86-9a1e-0c7d2e4f6a11"
     },
     "encounter": {
      "reference": "urn:uuid:5b0e7c1a-3d24-4f86-9a1e-0c7d2e4f6a12"
     },
     "effectiveDateTime": "2026-09-16T14:10:00+08:00",
     "valueQuantity": {
      "value": 88,
      "unit": "beats/minute",
      "system": "http://unitsofmeasure.org",
      "code": "/min"
     }
    }
   }
  ]
 },
 "source_text": "仁心聯合醫院（虛構）　耳鼻喉科門診紀錄\n就診日期：115/09/16 14:10　　科別：耳鼻喉科　　醫師：郭明哲\n姓名：黃志豪　　性別：男　　出生日期：民國70年11月3日（44歲）\n病歷號：R0418827　　身分證字號：E103572464\n\nS:\n右側臉頰脹痛、黃綠色濃鼻涕 5 天，合併鼻塞與後鼻漏，低頭時疼痛加劇。\n一週前有感冒症狀，已自行服用成藥。否認視力模糊、眼眶腫脹；否認高燒。\nPMH：過敏性鼻炎（季節性）。Allergy：Sulfa drugs（皮疹）。\n\nO:\nHR 88/min　BT 37.4°C\n鼻內視鏡：右側中鼻道膿性分泌物，下鼻甲腫脹；右上頷竇區壓痛 (+)。\n\nA:\nAcute sinusitis　急性鼻竇炎（右側上頷竇）\n\nP:\n1. Amoxicillin/clavulanate 500/125 mg 1# TID × 7 天。\n2. 生理食鹽水洗鼻，每日兩次。\n3. 一週後回診；若眼眶腫脹或劇烈頭痛請立即就醫。",
 "site_config": "院所設定（資訊系統提供，非病歷內容）\n- 國民身分證統一編號 identifier.system：http://www.moi.gov.tw\n- 本院病歷號 identifier.system：https://www.renxin-hosp.example.org.tw/mrn",
 "package_id": "tw.gov.mohw.twcore",
 "version": "1.0.0",
 "evidence_map": [
  {
   "path": "Bundle.entry[0].resource.identifier[0]",
   "quote": "身分證字號：E103572464"
  },
  {
   "path": "Bundle.entry[0].resource.identifier[1]",
   "quote": "病歷號：R0418827"
  },
  {
   "path": "Bundle.entry[0].resource.name[0]",
   "quote": "姓名：黃志豪"
  },
  {
   "path": "Bundle.entry[0].resource.gender",
   "quote": "性別：男"
  },
  {
   "path": "Bundle.entry[0].resource.birthDate",
   "quote": "出生日期：民國70年11月3日"
  },
  {
   "path": "Bundle.entry[1].resource.class",
   "quote": "耳鼻喉科門診紀錄"
  },
  {
   "path": "Bundle.entry[1].resource.serviceType",
   "quote": "科別：耳鼻喉科"
  },
  {
   "path": "Bundle.entry[1].resource.period.start",
   "quote": "就診日期：115/09/16 14:10"
  },
  {
   "path": "Bundle.entry[2].resource.code",
   "quote": "Acute sinusitis　急性鼻竇炎（右側上頷竇）"
  },
  {
   "path": "Bundle.entry[2].resource.recordedDate",
   "quote": "就診日期：115/09/16 14:10"
  },
  {
   "path": "Bundle.entry[3].resource.code",
   "quote": "HR 88/min"
  },
  {
   "path": "Bundle.entry[3].resource.valueQuantity",
   "quote": "HR 88/min"
  },
  {
   "path": "Bundle.entry[3].resource.effectiveDateTime",
   "quote": "就診日期：115/09/16 14:10"
  }
 ],
 "mode": "strict"
};

/** Same record, Encounter.period.start moved to 2026-09-19 (expected: G-VALUE-MISMATCH on period.start) */
export const GROUNDING_WRONG_DATE_INPUT: Json = {
 "bundle": {
  "resourceType": "Bundle",
  "meta": {
   "profile": [
    "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/Bundle-twcore"
   ]
  },
  "type": "collection",
  "timestamp": "2026-09-16T15:00:00+08:00",
  "entry": [
   {
    "fullUrl": "urn:uuid:5b0e7c1a-3d24-4f86-9a1e-0c7d2e4f6a11",
    "resource": {
     "resourceType": "Patient",
     "meta": {
      "profile": [
       "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/Patient-twcore"
      ]
     },
     "identifier": [
      {
       "use": "official",
       "type": {
        "coding": [
         {
          "system": "http://terminology.hl7.org/CodeSystem/v2-0203",
          "code": "NNxxx"
         }
        ]
       },
       "system": "http://www.moi.gov.tw",
       "value": "E103572464"
      },
      {
       "use": "official",
       "type": {
        "coding": [
         {
          "system": "http://terminology.hl7.org/CodeSystem/v2-0203",
          "code": "MR"
         }
        ]
       },
       "system": "https://www.renxin-hosp.example.org.tw/mrn",
       "value": "R0418827"
      }
     ],
     "active": true,
     "name": [
      {
       "use": "official",
       "text": "黃志豪",
       "family": "黃",
       "given": [
        "志豪"
       ]
      }
     ],
     "gender": "male",
     "birthDate": "1981-11-03"
    }
   },
   {
    "fullUrl": "urn:uuid:5b0e7c1a-3d24-4f86-9a1e-0c7d2e4f6a12",
    "resource": {
     "resourceType": "Encounter",
     "meta": {
      "profile": [
       "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/Encounter-twcore"
      ]
     },
     "status": "finished",
     "class": {
      "system": "http://terminology.hl7.org/CodeSystem/v3-ActCode",
      "code": "AMB",
      "display": "ambulatory"
     },
     "serviceType": {
      "coding": [
       {
        "system": "http://snomed.info/sct",
        "code": "418960008",
        "display": "Otolaryngology"
       }
      ],
      "text": "耳鼻喉科"
     },
     "subject": {
      "reference": "urn:uuid:5b0e7c1a-3d24-4f86-9a1e-0c7d2e4f6a11"
     },
     "period": {
      "start": "2026-09-19T14:10:00+08:00"
     }
    }
   },
   {
    "fullUrl": "urn:uuid:5b0e7c1a-3d24-4f86-9a1e-0c7d2e4f6a13",
    "resource": {
     "resourceType": "Condition",
     "meta": {
      "profile": [
       "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/Condition-twcore"
      ]
     },
     "clinicalStatus": {
      "coding": [
       {
        "system": "http://terminology.hl7.org/CodeSystem/condition-clinical",
        "code": "active",
        "display": "Active"
       }
      ]
     },
     "verificationStatus": {
      "coding": [
       {
        "system": "http://terminology.hl7.org/CodeSystem/condition-ver-status",
        "code": "confirmed",
        "display": "Confirmed"
       }
      ]
     },
     "category": [
      {
       "coding": [
        {
         "system": "http://terminology.hl7.org/CodeSystem/condition-category",
         "code": "encounter-diagnosis",
         "display": "Encounter Diagnosis"
        }
       ]
      }
     ],
     "code": {
      "coding": [
       {
        "system": "http://hl7.org/fhir/sid/icd-10-cm",
        "code": "J01.90",
        "display": "Acute sinusitis, unspecified"
       }
      ],
      "text": "Acute sinusitis 急性鼻竇炎"
     },
     "subject": {
      "reference": "urn:uuid:5b0e7c1a-3d24-4f86-9a1e-0c7d2e4f6a11"
     },
     "encounter": {
      "reference": "urn:uuid:5b0e7c1a-3d24-4f86-9a1e-0c7d2e4f6a12"
     },
     "recordedDate": "2026-09-16"
    }
   },
   {
    "fullUrl": "urn:uuid:5b0e7c1a-3d24-4f86-9a1e-0c7d2e4f6a14",
    "resource": {
     "resourceType": "Observation",
     "meta": {
      "profile": [
       "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/Observation-heart-rate-twcore"
      ]
     },
     "status": "final",
     "category": [
      {
       "coding": [
        {
         "system": "http://terminology.hl7.org/CodeSystem/observation-category",
         "code": "vital-signs",
         "display": "Vital Signs"
        }
       ]
      }
     ],
     "code": {
      "coding": [
       {
        "system": "http://loinc.org",
        "code": "8867-4",
        "display": "Heart rate"
       }
      ],
      "text": "心跳 HR"
     },
     "subject": {
      "reference": "urn:uuid:5b0e7c1a-3d24-4f86-9a1e-0c7d2e4f6a11"
     },
     "encounter": {
      "reference": "urn:uuid:5b0e7c1a-3d24-4f86-9a1e-0c7d2e4f6a12"
     },
     "effectiveDateTime": "2026-09-16T14:10:00+08:00",
     "valueQuantity": {
      "value": 88,
      "unit": "beats/minute",
      "system": "http://unitsofmeasure.org",
      "code": "/min"
     }
    }
   }
  ]
 },
 "source_text": "仁心聯合醫院（虛構）　耳鼻喉科門診紀錄\n就診日期：115/09/16 14:10　　科別：耳鼻喉科　　醫師：郭明哲\n姓名：黃志豪　　性別：男　　出生日期：民國70年11月3日（44歲）\n病歷號：R0418827　　身分證字號：E103572464\n\nS:\n右側臉頰脹痛、黃綠色濃鼻涕 5 天，合併鼻塞與後鼻漏，低頭時疼痛加劇。\n一週前有感冒症狀，已自行服用成藥。否認視力模糊、眼眶腫脹；否認高燒。\nPMH：過敏性鼻炎（季節性）。Allergy：Sulfa drugs（皮疹）。\n\nO:\nHR 88/min　BT 37.4°C\n鼻內視鏡：右側中鼻道膿性分泌物，下鼻甲腫脹；右上頷竇區壓痛 (+)。\n\nA:\nAcute sinusitis　急性鼻竇炎（右側上頷竇）\n\nP:\n1. Amoxicillin/clavulanate 500/125 mg 1# TID × 7 天。\n2. 生理食鹽水洗鼻，每日兩次。\n3. 一週後回診；若眼眶腫脹或劇烈頭痛請立即就醫。",
 "site_config": "院所設定（資訊系統提供，非病歷內容）\n- 國民身分證統一編號 identifier.system：http://www.moi.gov.tw\n- 本院病歷號 identifier.system：https://www.renxin-hosp.example.org.tw/mrn",
 "package_id": "tw.gov.mohw.twcore",
 "version": "1.0.0",
 "evidence_map": [
  {
   "path": "Bundle.entry[0].resource.identifier[0]",
   "quote": "身分證字號：E103572464"
  },
  {
   "path": "Bundle.entry[0].resource.identifier[1]",
   "quote": "病歷號：R0418827"
  },
  {
   "path": "Bundle.entry[0].resource.name[0]",
   "quote": "姓名：黃志豪"
  },
  {
   "path": "Bundle.entry[0].resource.gender",
   "quote": "性別：男"
  },
  {
   "path": "Bundle.entry[0].resource.birthDate",
   "quote": "出生日期：民國70年11月3日"
  },
  {
   "path": "Bundle.entry[1].resource.class",
   "quote": "耳鼻喉科門診紀錄"
  },
  {
   "path": "Bundle.entry[1].resource.serviceType",
   "quote": "科別：耳鼻喉科"
  },
  {
   "path": "Bundle.entry[1].resource.period.start",
   "quote": "就診日期：115/09/16 14:10"
  },
  {
   "path": "Bundle.entry[2].resource.code",
   "quote": "Acute sinusitis　急性鼻竇炎（右側上頷竇）"
  },
  {
   "path": "Bundle.entry[2].resource.recordedDate",
   "quote": "就診日期：115/09/16 14:10"
  },
  {
   "path": "Bundle.entry[3].resource.code",
   "quote": "HR 88/min"
  },
  {
   "path": "Bundle.entry[3].resource.valueQuantity",
   "quote": "HR 88/min"
  },
  {
   "path": "Bundle.entry[3].resource.effectiveDateTime",
   "quote": "就診日期：115/09/16 14:10"
  }
 ],
 "mode": "strict"
};

/** Fictional internal-medicine visit; the Bundle adds a type 2 diabetes Condition the record never states (auto mode; expected: G-UNGROUNDED on entry[3].code) */
export const GROUNDING_FABRICATED_INPUT: Json = {
 "bundle": {
  "resourceType": "Bundle",
  "meta": {
   "profile": [
    "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/Bundle-twcore"
   ]
  },
  "type": "collection",
  "entry": [
   {
    "fullUrl": "urn:uuid:9e41d6b2-8a07-4c3f-b5d1-2f6a8c0e4b21",
    "resource": {
     "resourceType": "Patient",
     "meta": {
      "profile": [
       "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/Patient-twcore"
      ]
     },
     "identifier": [
      {
       "use": "official",
       "type": {
        "coding": [
         {
          "system": "http://terminology.hl7.org/CodeSystem/v2-0203",
          "code": "NNxxx"
         }
        ]
       },
       "system": "http://www.moi.gov.tw",
       "value": "K205813796"
      }
     ],
     "name": [
      {
       "use": "usual",
       "text": "許雅琳"
      }
     ],
     "gender": "female",
     "birthDate": "1992-02-14"
    }
   },
   {
    "fullUrl": "urn:uuid:9e41d6b2-8a07-4c3f-b5d1-2f6a8c0e4b22",
    "resource": {
     "resourceType": "Encounter",
     "meta": {
      "profile": [
       "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/Encounter-twcore"
      ]
     },
     "status": "finished",
     "class": {
      "system": "http://terminology.hl7.org/CodeSystem/v3-ActCode",
      "code": "AMB",
      "display": "ambulatory"
     },
     "subject": {
      "reference": "urn:uuid:9e41d6b2-8a07-4c3f-b5d1-2f6a8c0e4b21"
     },
     "period": {
      "start": "2026-08-27T10:35:00+08:00"
     }
    }
   },
   {
    "fullUrl": "urn:uuid:9e41d6b2-8a07-4c3f-b5d1-2f6a8c0e4b23",
    "resource": {
     "resourceType": "Condition",
     "meta": {
      "profile": [
       "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/Condition-twcore"
      ]
     },
     "clinicalStatus": {
      "coding": [
       {
        "system": "http://terminology.hl7.org/CodeSystem/condition-clinical",
        "code": "active"
       }
      ]
     },
     "verificationStatus": {
      "coding": [
       {
        "system": "http://terminology.hl7.org/CodeSystem/condition-ver-status",
        "code": "confirmed"
       }
      ]
     },
     "category": [
      {
       "coding": [
        {
         "system": "http://terminology.hl7.org/CodeSystem/condition-category",
         "code": "encounter-diagnosis"
        }
       ]
      }
     ],
     "code": {
      "coding": [
       {
        "system": "http://hl7.org/fhir/sid/icd-10-cm",
        "code": "J20.9",
        "display": "Acute bronchitis, unspecified"
       }
      ],
      "text": "急性支氣管炎"
     },
     "subject": {
      "reference": "urn:uuid:9e41d6b2-8a07-4c3f-b5d1-2f6a8c0e4b21"
     },
     "encounter": {
      "reference": "urn:uuid:9e41d6b2-8a07-4c3f-b5d1-2f6a8c0e4b22"
     }
    }
   },
   {
    "fullUrl": "urn:uuid:9e41d6b2-8a07-4c3f-b5d1-2f6a8c0e4b24",
    "resource": {
     "resourceType": "Condition",
     "meta": {
      "profile": [
       "https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/Condition-twcore"
      ]
     },
     "clinicalStatus": {
      "coding": [
       {
        "system": "http://terminology.hl7.org/CodeSystem/condition-clinical",
        "code": "active"
       }
      ]
     },
     "verificationStatus": {
      "coding": [
       {
        "system": "http://terminology.hl7.org/CodeSystem/condition-ver-status",
        "code": "confirmed"
       }
      ]
     },
     "category": [
      {
       "coding": [
        {
         "system": "http://terminology.hl7.org/CodeSystem/condition-category",
         "code": "encounter-diagnosis"
        }
       ]
      }
     ],
     "code": {
      "coding": [
       {
        "system": "http://hl7.org/fhir/sid/icd-10-cm",
        "code": "E11.9",
        "display": "Type 2 diabetes mellitus without complications"
       }
      ],
      "text": "第二型糖尿病"
     },
     "subject": {
      "reference": "urn:uuid:9e41d6b2-8a07-4c3f-b5d1-2f6a8c0e4b21"
     },
     "encounter": {
      "reference": "urn:uuid:9e41d6b2-8a07-4c3f-b5d1-2f6a8c0e4b22"
     }
    }
   }
  ]
 },
 "source_text": "康寧社區診所（虛構）　一般內科門診\n看診日期：2026-08-27 10:35\n病人：許雅琳　　女　　生日：1992/02/14　　身分證字號：K205813796\n\n主訴：咳嗽有痰 6 天，夜間咳嗽較明顯，無發燒。\n過去病史：無慢性病，平時未服藥。Allergy：NKDA。\n理學檢查：HR 92/min，SpO2 98%，兩側肺部少許 rhonchi，無 wheezing。\n診斷：Acute bronchitis　急性支氣管炎\n處置：Ambroxol 30 mg 1# TID × 5 天；多休息、多喝水；若發燒或呼吸喘請回診。",
 "site_config": "院所設定（資訊系統提供，非病歷內容）\n- 國民身分證統一編號 identifier.system：http://www.moi.gov.tw",
 "package_id": "tw.gov.mohw.twcore",
 "version": "1.0.0",
 "mode": "auto"
};

/** Fictional diabetes follow-up; every target fact is stated (expected: complete) */
export const COMPLETENESS_COMPLETE_INPUT: Json = {
 "targets": [
  {
   "key": "patient",
   "resourceType": "Patient"
  },
  {
   "key": "dx",
   "resourceType": "Condition",
   "category": "problem-list-item",
   "item": "第二型糖尿病",
   "aliases": [
    "第二型糖尿病",
    "Type 2 diabetes mellitus"
   ]
  },
  {
   "key": "a1c",
   "resourceType": "Observation",
   "item": "HbA1c",
   "aliases": [
    "HbA1c",
    "糖化血色素"
   ]
  },
  {
   "key": "glu",
   "resourceType": "Observation",
   "item": "空腹血糖",
   "aliases": [
    "空腹血糖",
    "Fasting glucose",
    "AC sugar"
   ]
  },
  {
   "key": "met",
   "resourceType": "MedicationRequest",
   "item": "Metformin",
   "aliases": [
    "Metformin",
    "Glucophage"
   ]
  }
 ],
 "source_text": "新陳代謝科門診（虛構：高雄 安泰診所）　115/07/08\n病人：蔡文雄　男　1968/05/30　身分證號 P128460356\n第二型糖尿病（Type 2 diabetes mellitus, E11.9）門診追蹤，自述飲食控制尚可。\n今日檢驗：HbA1c 7.4 %，空腹血糖 (Fasting glucose) 142 mg/dL。\n處方：Metformin 500 mg 1# BID 口服，飯後服用，共 28 天。",
 "site_config": "院所設定（資訊系統提供，非病歷內容）\n- 國民身分證統一編號 identifier.system：http://www.moi.gov.tw",
 "package_id": "tw.gov.mohw.twcore",
 "version": "1.0.0"
};

/** Same visit without the HbA1c result and the Metformin dose / frequency (expected: insufficient_information) */
export const COMPLETENESS_INSUFFICIENT_INPUT: Json = {
 "targets": [
  {
   "key": "patient",
   "resourceType": "Patient"
  },
  {
   "key": "dx",
   "resourceType": "Condition",
   "category": "problem-list-item",
   "item": "第二型糖尿病",
   "aliases": [
    "第二型糖尿病",
    "Type 2 diabetes mellitus"
   ]
  },
  {
   "key": "a1c",
   "resourceType": "Observation",
   "item": "HbA1c",
   "aliases": [
    "HbA1c",
    "糖化血色素"
   ]
  },
  {
   "key": "glu",
   "resourceType": "Observation",
   "item": "空腹血糖",
   "aliases": [
    "空腹血糖",
    "Fasting glucose",
    "AC sugar"
   ]
  },
  {
   "key": "met",
   "resourceType": "MedicationRequest",
   "item": "Metformin",
   "aliases": [
    "Metformin",
    "Glucophage"
   ]
  }
 ],
 "source_text": "新陳代謝科門診（虛構：高雄 安泰診所）　115/07/08\n病人：蔡文雄　男　1968/05/30　身分證號 P128460356\n第二型糖尿病（Type 2 diabetes mellitus, E11.9）門診追蹤，自述飲食控制尚可。\n空腹血糖 (Fasting glucose) 142 mg/dL。\n處方：Metformin 續用，共 28 天。\nHbA1c 今日已抽血，報告尚未出來。",
 "site_config": "院所設定（資訊系統提供，非病歷內容）\n- 國民身分證統一編號 identifier.system：http://www.moi.gov.tw",
 "package_id": "tw.gov.mohw.twcore",
 "version": "1.0.0"
};
