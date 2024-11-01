
using System.Text.Json.Nodes;
using Amazon;
using Amazon.BedrockRuntime;
using Amazon.BedrockRuntime.Model;
using Amazon.Lambda.Core;
using Amazon.Util;
using ProjectTestsLib.Helper;

namespace ServerlessAPI.Helper;
public class AwsBedrock
{
    private readonly ILambdaLogger logger;
    private DynamoDB dynamoDB;

    public AwsBedrock(ILambdaLogger logger, DynamoDB dynamoDB)
    {
        this.logger = logger;
        this.dynamoDB = dynamoDB;
    }


    public async Task<string?> RandomNPCConversation()
    {
        string prompt = """
           Write a short sentence in less than 20 words to the AWS warrior to encorage him to fight the monster.
        """;
        Random random = new Random();
        int randomNumber = random.Next(1, 6);
        return await InvokeTitanTextAsync(prompt + "->" + randomNumber, "amazon.titan-text-premier-v1:0");
    }

    public async Task<string?> RewriteInstruction(string instruction)
    {
        string prompt =
 """
 <Message>
 """ + instruction +
@"""
</Message>
Rewrite the message with the tone as a girl in age 20 and ask for help from the AWS warrior.            
        """;

        return await InvokeTitanTextAsync(prompt, "amazon.titan-text-premier-v1:0");
    }


    private async Task<string?> InvokeTitanTextAsync(string prompt, string titanTextModelId = "amazon.titan-text-express-v1")
    {
        string? cachedResult = await dynamoDB.GetCachedInstruction(prompt);
        if (!string.IsNullOrEmpty(cachedResult))
        {
            return cachedResult;
        }

        string payload = CreatePayload(prompt);

        string? generatedText = null;
        var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        try
        {
            logger.Log($"InvokeModelAsync {titanTextModelId} with payload\n: {payload}");

            InvokeModelResponse response = await InvokeModelAsync(titanTextModelId, payload, cts.Token);
            generatedText = await ParseResponseAsync(response);
        }
        catch (TaskCanceledException)
        {
            logger.LogError("InvokeModelAsync timed out after 20 seconds!");
            return string.Empty;
        }
        catch (AmazonBedrockRuntimeException e)
        {
            logger.LogError("AmazonBedrockRuntimeException: " + e.Message);
            return null;
        }

        if (!string.IsNullOrEmpty(generatedText))
        {
            await dynamoDB.SaveCachedInstruction(prompt, generatedText);
        }
        return generatedText;
    }

    private string CreatePayload(string prompt)
    {
        return new JsonObject
        {
            { "inputText", prompt },
            { "textGenerationConfig", new JsonObject
                {
                    { "maxTokenCount", 1024 },
                    { "temperature", 1f },
                    { "topP", 0.6f }
                }
            }
        }.ToJsonString();
    }

    private async Task<InvokeModelResponse> InvokeModelAsync(string modelId, string payload, CancellationToken cancellationToken)
    {
        using var client = new AmazonBedrockRuntimeClient(RegionEndpoint.USEast1);
        return await client.InvokeModelAsync(new InvokeModelRequest
        {
            ModelId = modelId,
            Body = AWSSDKUtils.GenerateMemoryStreamFromString(payload),
            ContentType = "application/json",
            Accept = "application/json"
        }, cancellationToken);
    }

    private async Task<string?> ParseResponseAsync(InvokeModelResponse response)
    {
        if (response.HttpStatusCode == System.Net.HttpStatusCode.OK)
        {
            var resultsNode = await JsonNode.ParseAsync(response.Body);
            var resultsArray = resultsNode?["results"]?.AsArray();
            if (resultsArray != null)
            {
                return string.Join(" ", resultsArray.Select(x => x?["outputText"]?.GetValue<string?>()));
            }
        }
        else
        {
            logger.LogError("InvokeModelAsync failed with status code " + response.HttpStatusCode);
        }
        return null;
    }

}