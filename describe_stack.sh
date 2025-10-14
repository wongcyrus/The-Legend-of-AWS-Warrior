#!/bin/bash

# Describe CloudProjectMarker stack and display in table format
echo "=== CloudProjectMarker Stack Information ==="

# Get the full stack details
STACK_OUTPUT=$(aws cloudformation describe-stacks --stack-name CloudProjectMarker)

# Extract and display stack basic info in table format
echo "Stack Basic Information:"
echo "+-----------------------+----------------------------------------+"
printf "| %-21s | %-38s |\n" "Property" "Value"
echo "+-----------------------+----------------------------------------+"
printf "| %-21s | %-38s |\n" "Stack Name" "$(echo "$STACK_OUTPUT" | jq -r '.Stacks[0].StackName')"
printf "| %-21s | %-38s |\n" "Stack Status" "$(echo "$STACK_OUTPUT" | jq -r '.Stacks[0].StackStatus')"
printf "| %-21s | %-38s |\n" "Creation Time" "$(echo "$STACK_OUTPUT" | jq -r '.Stacks[0].CreationTime')"
printf "| %-21s | %-38s |\n" "Last Updated" "$(echo "$STACK_OUTPUT" | jq -r '.Stacks[0].LastUpdatedTime // "Never"')"
echo "+-----------------------+----------------------------------------+"

echo ""
echo "Stack Outputs:"
if echo "$STACK_OUTPUT" | jq -e '.Stacks[0].Outputs' > /dev/null 2>&1; then
    echo "+--------------------------------+--------------------------------------------------------+"
    printf "| %-30s | %-54s |\n" "Output Key" "Output Value"
    echo "+--------------------------------+--------------------------------------------------------+"
    echo "$STACK_OUTPUT" | jq -r '.Stacks[0].Outputs[]? | "\(.OutputKey)|\(.OutputValue)"' | while IFS='|' read -r key value; do
        printf "| %-30s | %-54s |\n" "$key" "$value"
    done
    echo "+--------------------------------+--------------------------------------------------------+"
else
    echo "No outputs found for this stack."
fi

echo ""
echo "Stack Parameters:"
if echo "$STACK_OUTPUT" | jq -e '.Stacks[0].Parameters' > /dev/null 2>&1; then
    echo "+--------------------------------+--------------------------------------------------------+"
    printf "| %-30s | %-54s |\n" "Parameter Key" "Parameter Value"
    echo "+--------------------------------+--------------------------------------------------------+"
    echo "$STACK_OUTPUT" | jq -r '.Stacks[0].Parameters[]? | "\(.ParameterKey)|\(.ParameterValue)"' | while IFS='|' read -r key value; do
        printf "| %-30s | %-54s |\n" "$key" "$value"
    done
    echo "+--------------------------------+--------------------------------------------------------+"
else
    echo "No parameters found for this stack."
fi