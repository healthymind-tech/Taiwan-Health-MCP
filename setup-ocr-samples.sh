#!/bin/bash
# Setup script for OCR test samples directory

set -e

SAMPLES_DIR="public/samples"

echo "🔧 OCR Test Samples Setup"
echo "=========================="
echo ""

# Create directory if it doesn't exist
if [ ! -d "$SAMPLES_DIR" ]; then
  echo "📁 Creating samples directory: $SAMPLES_DIR"
  mkdir -p "$SAMPLES_DIR"
  echo "✅ Directory created"
else
  echo "📁 Samples directory already exists: $SAMPLES_DIR"
fi

echo ""
echo "📋 Setup Instructions:"
echo "====================="
echo ""
echo "1. Place your sample files in: $SAMPLES_DIR/"
echo ""
echo "2. Supported file formats:"
echo "   - PDF: .pdf"
echo "   - Images: .jpg, .jpeg, .png, .gif, .bmp, .webp, .tiff, .tif"
echo ""
echo "3. File naming examples:"
echo "   - test-drug-insert.pdf"
echo "   - sample-medicine-box.jpg"
echo "   - supplement-label.png"
echo ""
echo "4. After adding samples, restart the service:"
echo "   docker compose restart app"
echo ""
echo "5. Or do a full rebuild:"
echo "   docker compose build && docker compose up -d"
echo ""

# Check if directory is empty
if [ -z "$(ls -A "$SAMPLES_DIR" 2>/dev/null)" ]; then
  echo "⚠️  Samples directory is currently empty"
  echo ""
  echo "📌 Example: To add a test PDF file:"
  echo "   cp /your/path/test-document.pdf $SAMPLES_DIR/"
  echo ""
  echo "📌 Example: To add a test image:"
  echo "   cp /your/path/test-image.jpg $SAMPLES_DIR/"
else
  echo "✅ Found sample files:"
  ls -lh "$SAMPLES_DIR" | tail -n +2 | awk '{printf "   - %s (%s)\n", $9, $5}'
fi

echo ""
echo "✅ Setup complete!"
echo ""
echo "🚀 Next steps:"
echo "1. Add your sample files to: $SAMPLES_DIR/"
echo "2. Restart the service"
echo "3. Open Admin → Settings → OCR Server"
echo "4. Click 'Test OCR' button"
echo "5. Your samples will appear in the 'Sample Files' section"
echo ""
