# Health Supplements Service

## Overview
The health supplements service focuses on data for health supplements certified with Taiwan's "Little Green Man" (小綠人) mark. It follows the Health Food Control Act strictly, providing information on government-approved health products to help users find safe, scientifically substantiated complementary options alongside conventional medical care.

## Key disclaimer
> **Note**: health supplements are not drugs and have no disease-treating efficacy. All information is for wellness reference only; treatment of disease must still follow a physician's instructions.

## Features

### 1. Health supplement lookup
Lets users look up legally approved health supplement information:
- **Product search**: search by product name (for example「靈芝」/ reishi or「魚油」/ fish oil).
- **Efficacy search**: search by health claim (for example「調節血脂」/ blood lipid regulation,「護肝」/ liver protection, or「免疫調節」/ immune modulation).
- **License search**: look up a specific 衛部健食字 license number.

### 2. Detailed product information
Provides the complete approved record for a product:
- **Approved efficacy**: the officially permitted health claims.
- **Functional ingredients**: the content of the specific ingredients responsible for the health function.
- **Warnings and precautions**: intake limits and contraindications for particular groups (such as pregnant women or infants).
- **Health claim statements**: a detailed summary of the scientific substantiation.

### 3. Disease-oriented complementary analysis
Combines ICD diagnoses with health supplement data to offer suggestions for a specific condition:
- **Association analysis**: analyses the link between a disease (such as diabetes) and a health claim (such as blood glucose regulation).
- **Product recommendation**: lists legal products certified for the relevant claim.
- **Safety reminders**: automatically attaches the relevant medical warnings.

## Health claim categories
The module covers the main claim categories approved under Taiwan regulation, including but not limited to:
- Gastrointestinal function improvement
- Blood lipid regulation
- Liver protection
- Bone health
- Immune modulation
- Support for adjusting allergic constitution
- Resistance to body-fat formation
- Blood glucose regulation
- Anti-fatigue
- Support for blood pressure regulation

## Technical architecture
- **Data source**: the Taiwan FDA health supplements dataset.
- **Integration**: this module works together with the `Nutrition Service`, distinguishing certified "health supplements" (bearing the Little Green Man mark) from ordinary "nutritional supplements".

## Use cases
1. **Nutrition consulting**: a reference for dietitians planning a wellness programme.
2. **Chronic disease management**: a lifestyle-adjustment reference for patients alongside conventional treatment.
3. **Consumer guidance**: helps the public identify legal, government-certified products.

## Key limitation
The disease mappings are developer-curated and have not been medically validated — they are not suitable for patient-facing use without expert review.
