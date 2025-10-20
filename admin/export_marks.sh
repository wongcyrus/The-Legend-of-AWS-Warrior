#!/bin/bash

# Load configuration
source "$(dirname "$0")/../config.sh"

# Get the PassedTestTable name from CloudFormation
table_name=$(get_table_name "PassedTestTable")

if [ -z "$table_name" ]; then
    echo "Error: Could not find PassedTestTable in stack outputs"
    exit 1
fi

echo "Exporting marks from table: $table_name"

aws dynamodb scan --table-name "$table_name" --region "$AWS_REGION" \
--select ALL_ATTRIBUTES --page-size 500 --max-items 100000 --output json \
| jq -r '.Items' \
| jq -r 'map({Test: .Test.S, User: .User.S, Marks: .Marks.N, Time: .Time.S}) | (.[0] | keys_unsorted) as $keys | $keys, map([.[ $keys[] ]])[] | @csv' \
> marks.csv

echo "Marks exported to marks.csv"