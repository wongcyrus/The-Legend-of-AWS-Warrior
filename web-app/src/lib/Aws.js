import {baseUrl as basedUrl} from "../Constant";
class Aws {
  extractAWSCredentials = (rawKey) => {
    const accessKeyStartIndex =
      rawKey.indexOf("aws_access_key_id=") + "aws_access_key_id=".length;
    const accessKeyId = rawKey
      .substring(accessKeyStartIndex, rawKey.indexOf("aws_secret_access_key="))
      .replace(/(\r\n|\n|\r)/gm, "");
    const secretKeyStartIndex =
      rawKey.indexOf("aws_secret_access_key=") +
      "aws_secret_access_key=".length;
    const secretAccessKey = rawKey
      .substring(secretKeyStartIndex, rawKey.indexOf("aws_session_token="))
      .replace(/(\r\n|\n|\r)/gm, "");
    const secretSessionTokenIndex =
      rawKey.indexOf("aws_session_token=") + "aws_session_token=".length;

    let secretSessionTokenEndIndex = rawKey.indexOf(
      "\r",
      secretSessionTokenIndex
    );
    if (secretSessionTokenEndIndex === -1)
      secretSessionTokenEndIndex = rawKey.length;

    const sessionToken = rawKey
      .substring(secretSessionTokenIndex, secretSessionTokenEndIndex)
      .replace(/(\r\n|\n|\r)/gm, "");
    console.log({ accessKeyId, secretAccessKey, sessionToken });

    return {
      aws_access_key_id: accessKeyId,
      aws_secret_access_key: secretAccessKey,
      aws_session_token: sessionToken,
    };
  };

  getApiUrl = (controller) => {
    const urlWithQueryParams = new URL(basedUrl + controller);
    const api_key = localStorage.getItem("api_key");
    if (!api_key) {
      alert("Please set the key first!");
      return;
    }
    urlWithQueryParams.searchParams.append("api_key", api_key);
    return urlWithQueryParams;
  };
}

export default Aws;
