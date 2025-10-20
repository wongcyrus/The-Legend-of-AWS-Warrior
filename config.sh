#!/bin/bash

# Common configuration loader for all scripts
# Source this file at the beginning of each script: source "$(dirname "$0")/../config.sh"

# Get the directory of this script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR" && pwd)"

# Load .env file if it exists
if [ -f "$PROJECT_ROOT/.env.local" ]; then
    set -a
    source "$PROJECT_ROOT/.env.local"
    set +a
elif [ -f "$PROJECT_ROOT/.env" ]; then
    set -a
    source "$PROJECT_ROOT/.env"
    set +a
else
    echo "Warning: No .env or .env.local file found. Using defaults."
fi

# Set defaults if not defined in .env
export AWS_REGION="${AWS_REGION:-us-east-1}"
export STACK_NAME="${STACK_NAME:-CloudProjectMarkerTest}"

# Function to get CloudFormation output value
get_stack_output() {
    local output_key="$1"
    aws cloudformation describe-stacks \
        --stack-name "$STACK_NAME" \
        --region "$AWS_REGION" \
        --no-cli-pager \
        --query "Stacks[0].Outputs[?OutputKey=='$output_key'].OutputValue" \
        --output text 2>/dev/null
}

# Function to get table name from CloudFormation outputs
get_table_name() {
    local table_key="$1"
    get_stack_output "$table_key"
}

# Export commonly used values
export PROJECT_ROOT
export SCRIPT_DIR

# Function to print configuration
print_config() {
    echo "=== Configuration ==="
    echo "Stack Name: $STACK_NAME"
    echo "Region: $AWS_REGION"
    echo "===================="
    echo ""
}
