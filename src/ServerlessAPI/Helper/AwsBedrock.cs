
using System.Text.Json.Nodes;
using Amazon;
using Amazon.BedrockRuntime;
using Amazon.BedrockRuntime.Model;
using Amazon.Lambda.Core;
using Amazon.Util;

namespace ServerlessAPI.Helper;
public class AwsBedrock
{
    private readonly ILambdaLogger logger;

    public AwsBedrock(ILambdaLogger logger)
    {
        this.logger = logger;
    }

    public async Task<string> RandomNPCConversation(){
        string prompt = """
           Write a short sentence in less than 20 words to the AWS warrior to encorage him to fight the monster.
        """;
        return await InvokeTitanTextG1Async(prompt);
    }

    public async Task<string> RewriteInstruction(string instruction)
    {
        string prompt =
 """
 <Message>
 """ + instruction + 
@"""
</Message>
Rewrite the message with the tone as a girl in age 20 and ask for help from the AWS warrior.            
        """;

        return await InvokeTitanTextG1Async(prompt);
    }


    private async Task<string> InvokeTitanTextG1Async(string prompt)
    {
        string titanTextG1ModelId = "amazon.titan-text-express-v1";
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

        string generatedText = "";
        try
        {
            InvokeModelResponse response = await client.InvokeModelAsync(new InvokeModelRequest()
            {
                ModelId = titanTextG1ModelId,
                Body = AWSSDKUtils.GenerateMemoryStreamFromString(payload),
                ContentType = "application/json",
                Accept = "application/json"
            });

            if (response.HttpStatusCode == System.Net.HttpStatusCode.OK)
            {
                var results = JsonNode.ParseAsync(response.Body).Result?["results"]?.AsArray();

                return results is null ? "" : string.Join(" ", results.Select(x => x?["outputText"]?.GetValue<string?>()));
            }
            else
            {
                logger.LogError("InvokeModelAsync failed with status code " + response.HttpStatusCode);
            }
        }
        catch (AmazonBedrockRuntimeException e)
        {
            logger.LogError(e.Message);
        }
        return generatedText;
    }

}