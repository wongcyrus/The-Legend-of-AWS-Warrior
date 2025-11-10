#!/bin/bash

# Script to batch generate API keys for all emails in email.txt
# Replicates KeyGenFunction.cs logic for multiple emails
# Usage: ./batch_generate_keys.sh [--force] [--parallel]
#   --force: Regenerate keys even if they already exist
#   --parallel: Generate keys in parallel (faster but more API calls)

# Note: Not using 'set -e' because we handle errors explicitly
# and want to continue processing all emails even if some fail

# Load configuration
source "$(dirname "$0")/../config.sh"

FORCE_FLAG=""
PARALLEL=false

# Parse arguments
for arg in "$@"; do
    case $arg in
        --force)
            FORCE_FLAG="--force"
            ;;
        --parallel)
            PARALLEL=true
            ;;
    esac
done

EMAIL_FILE="$(dirname "$0")/email.txt"

if [ ! -f "$EMAIL_FILE" ]; then
    echo "Error: email.txt not found at $EMAIL_FILE"
    exit 1
fi

echo "=== Batch Generate API Keys ==="
echo ""
print_config

EMAIL_COUNT=$(grep -c . "$EMAIL_FILE" 2>/dev/null || echo 0)
echo "Found $EMAIL_COUNT email(s) in email.txt"
echo ""

if [ "$PARALLEL" = true ]; then
    echo "Mode: Parallel (faster)"
else
    echo "Mode: Sequential (safer)"
fi

if [ -n "$FORCE_FLAG" ]; then
    echo "Force regenerate: Yes"
fi

echo ""
read -p "Continue? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted"
    exit 0
fi

echo ""
echo "Processing emails..."
echo ""

SUCCESS_COUNT=0
SKIP_COUNT=0
ERROR_COUNT=0
SCRIPT_DIR="$(dirname "$0")"

# Function to process a single email
process_email() {
    local email="$1"
    local force_flag="$2"
    
    echo "Processing: $email"
    
    OUTPUT=$("$SCRIPT_DIR/generate_api_key.sh" "$email" $force_flag 2>&1)
    RESULT=$?
    
    if [ $RESULT -eq 0 ]; then
        if echo "$OUTPUT" | grep -q "API key already exists"; then
            echo "  ✓ Already exists"
            return 2  # Skip
        else
            echo "  ✓ Generated"
            return 0  # Success
        fi
    else
        echo "  ✗ Failed"
        echo "$OUTPUT" | grep -i "error" | head -1 || echo "  Unknown error"
        return 1  # Error
    fi
}

if [ "$PARALLEL" = true ]; then
    # Parallel processing
    while read -r email; do
        [ -z "$email" ] && continue
        
        (
            process_email "$email" "$FORCE_FLAG"
            echo $? > "/tmp/result_${email//[^a-zA-Z0-9]/_}.txt"
        ) &
        
        # Limit concurrent processes
        if [ $(jobs -r | wc -l) -ge 10 ]; then
            wait -n
        fi
    done < "$EMAIL_FILE"
    
    # Wait for all to complete
    wait
    
    # Count results
    for result_file in /tmp/result_*.txt; do
        if [ -f "$result_file" ]; then
            RESULT=$(cat "$result_file")
            case $RESULT in
                0) SUCCESS_COUNT=$((SUCCESS_COUNT + 1)) ;;
                1) ERROR_COUNT=$((ERROR_COUNT + 1)) ;;
                2) SKIP_COUNT=$((SKIP_COUNT + 1)) ;;
            esac
            rm -f "$result_file"
        fi
    done
else
    # Sequential processing
    # Use while loop with proper handling of last line without newline
    while IFS= read -r email || [ -n "$email" ]; do
        # Skip empty lines
        [ -z "$email" ] && continue
        
        # Skip lines starting with # (comments)
        [[ "$email" =~ ^#.*$ ]] && continue
        
        process_email "$email" "$FORCE_FLAG" || true
        RESULT=$?
        
        case $RESULT in
            0) SUCCESS_COUNT=$((SUCCESS_COUNT + 1)) ;;
            1) ERROR_COUNT=$((ERROR_COUNT + 1)) ;;
            2) SKIP_COUNT=$((SKIP_COUNT + 1)) ;;
        esac
        
        echo ""
    done < "$EMAIL_FILE"
fi

echo ""
echo "=== Summary ==="
echo "Total emails: $EMAIL_COUNT"
echo "Generated: $SUCCESS_COUNT"
echo "Skipped (already exist): $SKIP_COUNT"
echo "Errors: $ERROR_COUNT"
echo ""

if [ $ERROR_COUNT -eq 0 ]; then
    echo "✅ Batch generation complete!"
    echo "Run ./validate_api_keys.sh to verify consistency."
else
    echo "⚠️  Completed with $ERROR_COUNT error(s)"
    echo "Check the output above for details."
fi
