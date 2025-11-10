#!/bin/bash

# Script to validate API keys consistency between API Gateway, DynamoDB, and email.txt
# Checks that all keys in the usage plan have corresponding entries in DynamoDB
# and that all emails in email.txt have keys in both systems
# Usage: ./validate_api_keys.sh

set -e

# Load configuration
source "$(dirname "$0")/../config.sh"

# Check if email.txt exists
EMAIL_FILE="$(dirname "$0")/email.txt"
if [ ! -f "$EMAIL_FILE" ]; then
    echo "Error: email.txt not found at $EMAIL_FILE"
    exit 1
fi

echo "=== Validate API Keys Consistency ==="
echo ""
print_config

# Get the Usage Plan ID and DynamoDB table name from the stack
echo "Fetching stack information..."
STACK_OUTPUT=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$AWS_REGION" \
    --no-cli-pager 2>/dev/null)

if [ $? -ne 0 ]; then
    echo "Error: Could not find stack '$STACK_NAME'"
    exit 1
fi

USAGE_PLAN_ID=$(echo "$STACK_OUTPUT" | jq -r '.Stacks[0].Outputs[] | select(.OutputKey=="UsagePlanId") | .OutputValue')
LOOKUP_TABLE=$(echo "$STACK_OUTPUT" | jq -r '.Stacks[0].Outputs[] | select(.OutputKey=="ApiKeyLookupTable") | .OutputValue')

if [ -z "$USAGE_PLAN_ID" ] || [ "$USAGE_PLAN_ID" == "null" ]; then
    echo "Error: Could not find Usage Plan ID in stack outputs"
    exit 1
fi

if [ -z "$LOOKUP_TABLE" ] || [ "$LOOKUP_TABLE" == "null" ]; then
    echo "Error: Could not find ApiKeyLookupTable in stack outputs"
    exit 1
fi

echo "Usage Plan ID: $USAGE_PLAN_ID"
echo "DynamoDB Table: $LOOKUP_TABLE"
echo ""

# Fetch all API keys from API Gateway usage plan
echo "Fetching API keys from API Gateway usage plan..."
API_KEYS_JSON=$(aws apigateway get-usage-plan-keys \
    --usage-plan-id "$USAGE_PLAN_ID" \
    --region "$AWS_REGION" \
    --no-cli-pager \
    --output json)

APIGW_KEY_COUNT=$(echo "$API_KEYS_JSON" | jq '.items | length')
echo "Found $APIGW_KEY_COUNT API key(s) in API Gateway"

# Fetch all items from DynamoDB
echo "Fetching API keys from DynamoDB..."
DYNAMO_ITEMS=$(aws dynamodb scan \
    --table-name "$LOOKUP_TABLE" \
    --region "$AWS_REGION" \
    --no-cli-pager \
    --output json)

DYNAMO_KEY_COUNT=$(echo "$DYNAMO_ITEMS" | jq '.Items | length')
echo "Found $DYNAMO_KEY_COUNT API key(s) in DynamoDB"

# Load email list (source of truth)
EMAIL_COUNT=$(grep -c . "$EMAIL_FILE" 2>/dev/null || echo 0)
echo "Found $EMAIL_COUNT email(s) in email.txt (source of truth)"
echo ""

# Create temporary files for comparison
TEMP_DIR=$(mktemp -d)
APIGW_KEYS_FILE="$TEMP_DIR/apigw_keys.txt"
APIGW_EMAILS_FILE="$TEMP_DIR/apigw_emails.txt"
DYNAMO_KEYS_FILE="$TEMP_DIR/dynamo_keys.txt"
DYNAMO_EMAILS_FILE="$TEMP_DIR/dynamo_emails.txt"
SOURCE_EMAILS_FILE="$TEMP_DIR/source_emails.txt"

# Extract API Gateway keys with their values
echo "Fetching API key values from API Gateway (this may take a moment)..."
TOTAL_KEYS=$(echo "$API_KEYS_JSON" | jq '.items | length')
CURRENT=0

echo "$API_KEYS_JSON" | jq -r '.items[] | "\(.name)|\(.id)"' | while IFS='|' read -r name id; do
    CURRENT=$((CURRENT + 1))
    if [ $((CURRENT % 10)) -eq 0 ]; then
        echo "  Progress: $CURRENT/$TOTAL_KEYS"
    fi
    
    KEY_VALUE=$(aws apigateway get-api-key \
        --api-key "$id" \
        --region "$AWS_REGION" \
        --include-value \
        --no-cli-pager \
        --query 'value' \
        --output text 2>/dev/null)
    
    if [ -n "$KEY_VALUE" ]; then
        echo "$KEY_VALUE|$name" >> "$APIGW_KEYS_FILE"
    fi
done

echo "✓ Fetched all API key values"

# Extract DynamoDB keys
echo "$DYNAMO_ITEMS" | jq -r '.Items[] | "\(.ApiKey.S)|\(.Email.S)"' > "$DYNAMO_KEYS_FILE"

# Extract email lists
cut -d'|' -f2 "$APIGW_KEYS_FILE" | sort > "$APIGW_EMAILS_FILE"
cut -d'|' -f2 "$DYNAMO_KEYS_FILE" | sort > "$DYNAMO_EMAILS_FILE"
sort "$EMAIL_FILE" > "$SOURCE_EMAILS_FILE"

# Sort key files for comparison
sort -o "$APIGW_KEYS_FILE" "$APIGW_KEYS_FILE" 2>/dev/null || touch "$APIGW_KEYS_FILE"
sort -o "$DYNAMO_KEYS_FILE" "$DYNAMO_KEYS_FILE" 2>/dev/null || touch "$DYNAMO_KEYS_FILE"

# Debug: Count actual lines in files
APIGW_FILE_COUNT=$(wc -l < "$APIGW_KEYS_FILE" 2>/dev/null || echo 0)
DYNAMO_FILE_COUNT=$(wc -l < "$DYNAMO_KEYS_FILE" 2>/dev/null || echo 0)
echo "Debug: API Gateway file has $APIGW_FILE_COUNT lines"
echo "Debug: DynamoDB file has $DYNAMO_FILE_COUNT lines"
echo ""

# Validation results
ISSUES_FOUND=0

echo "=== Validation Results ==="
echo ""

# Check 1: Emails in source list but missing from API Gateway
echo "1. Checking emails in email.txt but missing from API Gateway..."
MISSING_FROM_APIGW=0
while read -r email; do
    if ! grep -q "^$email$" "$APIGW_EMAILS_FILE" 2>/dev/null; then
        if [ $MISSING_FROM_APIGW -eq 0 ]; then
            echo "⚠️  Emails in email.txt but NO key in API Gateway:"
        fi
        echo "  - $email"
        MISSING_FROM_APIGW=$((MISSING_FROM_APIGW + 1))
        ISSUES_FOUND=$((ISSUES_FOUND + 1))
    fi
done < "$SOURCE_EMAILS_FILE"

if [ $MISSING_FROM_APIGW -eq 0 ]; then
    echo "✓ All emails from email.txt have keys in API Gateway"
fi
echo ""

# Check 2: Emails in source list but missing from DynamoDB
echo "2. Checking emails in email.txt but missing from DynamoDB..."
MISSING_FROM_DYNAMO=0
while read -r email; do
    if ! grep -q "^$email$" "$DYNAMO_EMAILS_FILE" 2>/dev/null; then
        if [ $MISSING_FROM_DYNAMO -eq 0 ]; then
            echo "⚠️  Emails in email.txt but NO entry in DynamoDB:"
        fi
        echo "  - $email"
        MISSING_FROM_DYNAMO=$((MISSING_FROM_DYNAMO + 1))
        ISSUES_FOUND=$((ISSUES_FOUND + 1))
    fi
done < "$SOURCE_EMAILS_FILE"

if [ $MISSING_FROM_DYNAMO -eq 0 ]; then
    echo "✓ All emails from email.txt have entries in DynamoDB"
fi
echo ""

# Check 3: Emails in API Gateway but not in source list (unauthorized)
echo "3. Checking for unauthorized emails in API Gateway..."
UNAUTHORIZED_APIGW=0
while read -r email; do
    if ! grep -q "^$email$" "$SOURCE_EMAILS_FILE" 2>/dev/null; then
        if [ $UNAUTHORIZED_APIGW -eq 0 ]; then
            echo "⚠️  Emails in API Gateway but NOT in email.txt (unauthorized):"
        fi
        echo "  - $email"
        UNAUTHORIZED_APIGW=$((UNAUTHORIZED_APIGW + 1))
        ISSUES_FOUND=$((ISSUES_FOUND + 1))
    fi
done < "$APIGW_EMAILS_FILE"

if [ $UNAUTHORIZED_APIGW -eq 0 ]; then
    echo "✓ No unauthorized emails in API Gateway"
fi
echo ""

# Check 4: Emails in DynamoDB but not in source list (orphaned)
echo "4. Checking for orphaned emails in DynamoDB..."
ORPHANED_DYNAMO=0
while read -r email; do
    if ! grep -q "^$email$" "$SOURCE_EMAILS_FILE" 2>/dev/null; then
        if [ $ORPHANED_DYNAMO -eq 0 ]; then
            echo "⚠️  Emails in DynamoDB but NOT in email.txt (orphaned):"
        fi
        echo "  - $email"
        ORPHANED_DYNAMO=$((ORPHANED_DYNAMO + 1))
        ISSUES_FOUND=$((ISSUES_FOUND + 1))
    fi
done < "$DYNAMO_EMAILS_FILE"

if [ $ORPHANED_DYNAMO -eq 0 ]; then
    echo "✓ No orphaned emails in DynamoDB"
fi
echo ""

# Check 5: Keys in API Gateway but not in DynamoDB
echo "5. Checking for API Gateway keys missing in DynamoDB..."
KEY_MISSING_IN_DYNAMO=0
while IFS='|' read -r key_value email; do
    if ! grep -q "^$key_value|" "$DYNAMO_KEYS_FILE" 2>/dev/null; then
        if [ $KEY_MISSING_IN_DYNAMO -eq 0 ]; then
            echo "⚠️  Keys in API Gateway but NOT in DynamoDB:"
        fi
        echo "  - Email: $email"
        echo "    Key: $key_value"
        KEY_MISSING_IN_DYNAMO=$((KEY_MISSING_IN_DYNAMO + 1))
        ISSUES_FOUND=$((ISSUES_FOUND + 1))
    fi
done < "$APIGW_KEYS_FILE"

if [ $KEY_MISSING_IN_DYNAMO -eq 0 ]; then
    echo "✓ All API Gateway keys exist in DynamoDB"
fi
echo ""

# Check 6: Keys in DynamoDB but not in API Gateway
echo "6. Checking for DynamoDB keys missing in API Gateway..."
KEY_MISSING_IN_APIGW=0
while IFS='|' read -r key_value email; do
    if ! grep -q "^$key_value|" "$APIGW_KEYS_FILE" 2>/dev/null; then
        if [ $KEY_MISSING_IN_APIGW -eq 0 ]; then
            echo "⚠️  Keys in DynamoDB but NOT in API Gateway:"
        fi
        echo "  - Email: $email"
        echo "    Key: $key_value"
        KEY_MISSING_IN_APIGW=$((KEY_MISSING_IN_APIGW + 1))
        ISSUES_FOUND=$((ISSUES_FOUND + 1))
    fi
done < "$DYNAMO_KEYS_FILE"

if [ $KEY_MISSING_IN_APIGW -eq 0 ]; then
    echo "✓ All DynamoDB keys exist in API Gateway"
fi
echo ""

# Check 7: Email mismatches (same key, different email)
echo "7. Checking for email mismatches (same key, different email)..."
MISMATCHES=0
while IFS='|' read -r key_value apigw_email; do
    dynamo_email=$(grep "^$key_value|" "$DYNAMO_KEYS_FILE" 2>/dev/null | cut -d'|' -f2)
    if [ -n "$dynamo_email" ] && [ "$apigw_email" != "$dynamo_email" ]; then
        if [ $MISMATCHES -eq 0 ]; then
            echo "⚠️  Email mismatches found:"
        fi
        echo "  - Key: $key_value"
        echo "    API Gateway email: $apigw_email"
        echo "    DynamoDB email: $dynamo_email"
        MISMATCHES=$((MISMATCHES + 1))
        ISSUES_FOUND=$((ISSUES_FOUND + 1))
    fi
done < "$APIGW_KEYS_FILE"

if [ $MISMATCHES -eq 0 ]; then
    echo "✓ No email mismatches found"
fi
echo ""

# Summary
echo "=== Summary ==="
echo "Source emails (email.txt): $EMAIL_COUNT"
echo "API Gateway keys: $APIGW_KEY_COUNT"
echo "DynamoDB entries: $DYNAMO_KEY_COUNT"
echo ""
echo "Issues found:"
echo "  - Emails missing from API Gateway: $MISSING_FROM_APIGW"
echo "  - Emails missing from DynamoDB: $MISSING_FROM_DYNAMO"
echo "  - Unauthorized emails in API Gateway: $UNAUTHORIZED_APIGW"
echo "  - Orphaned emails in DynamoDB: $ORPHANED_DYNAMO"
echo "  - Keys in API Gateway but not DynamoDB: $KEY_MISSING_IN_DYNAMO"
echo "  - Keys in DynamoDB but not API Gateway: $KEY_MISSING_IN_APIGW"
echo "  - Email mismatches: $MISMATCHES"
echo ""

# Cleanup
rm -rf "$TEMP_DIR"

if [ $ISSUES_FOUND -eq 0 ]; then
    echo "✅ Validation passed! All API keys are consistent."
    exit 0
else
    echo "❌ Validation failed! Found $ISSUES_FOUND issue(s)."
    exit 1
fi
