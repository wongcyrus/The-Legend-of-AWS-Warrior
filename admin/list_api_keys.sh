#!/bin/bash

# Script to list all API keys in the CloudProjectMarker stack's usage plan
# Useful for checking the current state before/after deletion
# Usage: ./list_api_keys.sh [output_file.csv]
# If output_file is not provided, saves to api_keys_YYYYMMDD_HHMMSS.csv by default

set -e

# Load configuration
source "$(dirname "$0")/../config.sh"

# Generate default output filename with timestamp if not provided
if [ -z "$1" ]; then
    OUTPUT_FILE="api_keys_$(date +%Y%m%d_%H%M%S).csv"
else
    OUTPUT_FILE="$1"
fi

echo "=== List All API Keys in Usage Plan ==="
echo ""
print_config

# Get the Usage Plan Name from the stack
echo "Fetching stack information..."
if ! STACK_OUTPUT=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$AWS_REGION" \
    --no-cli-pager 2>&1); then
    echo "Error: Could not fetch stack '$STACK_NAME'"
    echo "$STACK_OUTPUT"
    exit 1
fi

USAGE_PLAN_ID=$(echo "$STACK_OUTPUT" | jq -r '.Stacks[0].Outputs[] | select(.OutputKey=="UsagePlanId") | .OutputValue')
USAGE_PLAN_NAME=$(echo "$STACK_OUTPUT" | jq -r '.Stacks[0].Outputs[] | select(.OutputKey=="UsagePlanName") | .OutputValue // "grader-usage-plan"')

if [ -z "$USAGE_PLAN_ID" ] || [ "$USAGE_PLAN_ID" == "null" ]; then
    echo "Error: Could not find Usage Plan ID in stack outputs"
    echo "Please ensure the stack has been deployed with the UsagePlanId output"
    exit 1
fi

echo "Usage Plan Name: $USAGE_PLAN_NAME"
echo "Usage Plan ID: $USAGE_PLAN_ID"
echo ""

# Get all API keys in the usage plan with details
echo "Fetching API keys from usage plan..."
if ! API_KEYS_JSON=$(aws apigateway get-usage-plan-keys \
    --usage-plan-id "$USAGE_PLAN_ID" \
    --region "$AWS_REGION" \
    --no-cli-pager \
    --output json 2>&1); then
    echo "Error: Failed to fetch API keys from usage plan '$USAGE_PLAN_ID'"
    echo "$API_KEYS_JSON"
    exit 1
fi

KEY_COUNT=$(echo "$API_KEYS_JSON" | jq '.items | length')

if [ "$KEY_COUNT" -eq 0 ]; then
    echo "No API keys found in the usage plan."
    exit 0
fi

echo "Found $KEY_COUNT API key(s):"
echo ""

# Function to generate CSV output
generate_csv() {
    # CSV Header
    echo "Name,API Key ID,API Key Value"
    
    # CSV Data
    echo "$API_KEYS_JSON" | jq -r '.items[] | "\(.name)|\(.id)"' | while IFS='|' read -r name id; do
        # Fetch the actual API key value
        if ! KEY_VALUE=$(aws apigateway get-api-key \
            --api-key "$id" \
            --region "$AWS_REGION" \
            --include-value \
            --no-cli-pager \
            --query 'value' \
            --output text 2>&1); then
            KEY_VALUE="(unable to retrieve)"
        fi
        
        if [ -z "$KEY_VALUE" ]; then
            KEY_VALUE="(unable to retrieve)"
        fi
        
        # Escape commas in name/email if present and wrap in quotes
        name=$(echo "$name" | sed 's/"/""/g')
        
        echo "\"$name\",\"$id\",\"$KEY_VALUE\""
    done
}

# Save to file
echo "Generating CSV file..."
generate_csv > "$OUTPUT_FILE"
echo "✓ CSV output saved to: $OUTPUT_FILE"
echo ""
echo "Total: $KEY_COUNT API key(s)"
