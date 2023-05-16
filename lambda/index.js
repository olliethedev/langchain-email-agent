const aws = require("aws-sdk");
const ses = new aws.SES({ region: "us-east-1" });
const s3 = new aws.S3({ region: "us-east-1" });
const { simpleParser } = require("mailparser");

const { ChatOpenAI } = require("langchain/chat_models/openai");
const {
  SystemMessagePromptTemplate,
  HumanMessagePromptTemplate,
  AIMessagePromptTemplate,
  ChatPromptTemplate,
} = require("langchain/prompts");

const SES_Identity_Email = process.env.SES_EMAIL;
const API_KEY = process.env.OPENAI_API_KEY;

const createBodyPrompt = ChatPromptTemplate.fromPromptMessages([
  SystemMessagePromptTemplate.fromTemplate(
    `You are a customer support agent for a company. Your email address is ${SES_Identity_Email}. Your name is Jeff. You are writing an email to a customer. The customer's name is unknown.`
  ),
  HumanMessagePromptTemplate.fromTemplate(
    "Email sender:{sender}\nEmail subject:{subject}\nEmail history:{context}\nTask: Given the email history, please write an email response to the customer. The email response should be written in a polite and professional manner. It is a final draft. Dont leave placeholder text."
  ),
]);

exports.handler = async (event) => {
  console.log("Event: ", JSON.stringify(event, null, 2));
  for (let record of event.Records) {
    let mail = record.ses.mail;
    let sender = mail.source;
    let subject = mail.commonHeaders.subject;
    const { body } = await getBodyFromS3(mail.messageId);

    console.log({ sender, subject, body });

    const { text: responseBody, usage } = await createBody(
      "gpt-3.5-turbo",
      sender,
      subject,
      body
    );

    console.log({ responseBody, usage });

    await sendEmail(sender, subject, responseBody);
  }

  return {
    statusCode: 200,
    body: JSON.stringify("Hello from Lambda!"),
  };
};

function sendEmail(emailAddress, subject, text) {
  const params = {
    Destination: {
      ToAddresses: [emailAddress],
    },
    Message: {
      Body: {
        Text: {
          Data: `${text}`,
        },
        Html: {
          Charset: "UTF-8",
          Data: `${text}`,
        },
      },
      Subject: { Data: `RE:${subject}` },
    },
    Source: SES_Identity_Email,
  };

  return ses.sendEmail(params).promise();
}

async function getBodyFromS3(messageId) {
  const params = {
    Bucket: process.env.BUCKET_NAME, // replace with your bucket name
    Key: `emails/${messageId}`, // replace with the object key
  };

  try {
    const data = await s3.getObject(params).promise();
    const fileContent = data.Body.toString("utf-8"); // convert the file content to a string
    console.log(fileContent);

    // Use simpleParser instead of creating a new Mailparser and writing to it
    const mail = await simpleParser(data.Body);

    return {
      from: mail.from.text,
      subject: mail.subject,
      body: mail.text,
    };
  } catch (error) {
    console.log("Error", error);
  }
}

const createBody = async (
  modelName = "gpt-3.5-turbo",
  sender,
  subject,
  body
) => {
  const response = await getModel(modelName).generatePrompt([
    await createBodyPrompt.formatPromptValue({
      subject: subject,
      context: body,
      sender: sender,
    }),
  ]);
  return {
    text: response.generations[0][0].text,
    usage: response.llmOutput.tokenUsage.totalTokens,
  };
};

const getModel = (modelName = "gpt-3.5-turbo") => {
  return new ChatOpenAI({
    openAIApiKey: API_KEY,
    temperature: 0.5,
    maxRetries: 3,
    timeout: 540000,
    modelName,
    verbose: true,
  });
};
