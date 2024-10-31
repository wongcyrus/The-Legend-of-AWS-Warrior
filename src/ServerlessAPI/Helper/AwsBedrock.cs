
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
        return await InvokeTitanTextAsync(prompt + "->" + randomNumber, "amazon.titan-text-lite-v1");
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
        AmazonBedrockRuntimeClient client = new(RegionEndpoint.USEast1);
        string payload = new JsonObject()
            {
                { "inputText", prompt },
                { "textGenerationConfig", new JsonObject()
                    {
                        { "maxTokenCount", 1024 },
                        { "temperature", 1f },
                        { "topP", 0.6f }
                    }
                }
            }.ToJsonString();

        string? generatedText = null;
        var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        try
        {
            logger.Log($@"InvokeModelAsync ${titanTextModelId} with payload\n: {payload}");

            InvokeModelResponse response = await client.InvokeModelAsync(new InvokeModelRequest()
            {
                ModelId = titanTextModelId,
                Body = AWSSDKUtils.GenerateMemoryStreamFromString(payload),
                ContentType = "application/json",
                Accept = "application/json"
            }, cts.Token);
            if (response.HttpStatusCode == System.Net.HttpStatusCode.OK)
            {
                var results = JsonNode.ParseAsync(response.Body).Result?["results"]?.AsArray();
                if (results != null)
                    generatedText = string.Join(" ", results.Select(x => x?["outputText"]?.GetValue<string?>()));
            }
            else
            {
                logger.LogError("InvokeModelAsync failed with status code " + response.HttpStatusCode);
            }
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
            await dynamoDB.SaveCachedInstruction(prompt, generatedText);
        return generatedText;
    }

}