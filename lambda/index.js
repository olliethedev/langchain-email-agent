const aws = require("aws-sdk");
const ses = new aws.SES({ region: "us-east-1" });
const s3 = new aws.S3({ region: "us-east-1" });
const { simpleParser } = require("mailparser");
const { ZeroShotAgent, AgentExecutor } = require("langchain/agents");
const { LLMChain } = require("langchain/chains");

const { ChatOpenAI } = require("langchain/chat_models/openai");
const { OpenAIEmbeddings } = require("langchain/embeddings/openai");
const { WebBrowser } = require("langchain/tools/webbrowser");

const {
  SystemMessagePromptTemplate,
  HumanMessagePromptTemplate,
  AIMessagePromptTemplate,
  ChatPromptTemplate,
} = require("langchain/prompts");

const SES_Identity_Email = process.env.SES_EMAIL;
const API_KEY = process.env.OPENAI_API_KEY;
const INFO_SOURCE = process.env.INFO_SOURCE;

exports.handler = async (event) => {
  console.log("Event: ", JSON.stringify(event, null, 2));
  for (let record of event.Records) {
    try {
      let mail = record.ses.mail;
      let sender = mail.source;
      let subject = mail.commonHeaders.subject;
      const { body } = await getBodyFromS3(mail.messageId);

      console.log({ sender, subject, body });

      const { text: responseBody } = await createBody(
        "gpt-3.5-turbo",
        sender,
        subject,
        body
      );

      console.log({ responseBody });

      await sendEmail(sender, subject, responseBody);
    } catch (error) {
      console.log(error);
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify("Event processed successfully!"),
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
  const chat = await getModel(modelName);
  //   const browsingModel = new ChatOpenAI({ temperature: 0 });
  const embeddings = new OpenAIEmbeddings();
  const tools = [new WebBrowser({ model: chat, embeddings })];

  const createBodyPrompt = ChatPromptTemplate.fromPromptMessages([
    SystemMessagePromptTemplate.fromTemplate(
      `You are a customer support agent for a company. Your email address is ${SES_Identity_Email}. Your name is Jeff. You are writing an email to a customer.`
    ),
    new HumanMessagePromptTemplate(
      ZeroShotAgent.createPrompt(tools, {
        prefix: `You are a customer support agent for a company. Your email address is ${SES_Identity_Email}. Your name is Jeff. You are writing an email to a customer. You have access to the following tools:`,
        suffix: `Business information source: ${INFO_SOURCE} \nTask: Given the email history, please write an email response to the customer. The email response should be written in a polite and professional manner. It is a final draft. Dont leave placeholder text.`,
      })
    ),
    AIMessagePromptTemplate.fromTemplate("Understood."),
    HumanMessagePromptTemplate.fromTemplate(`{input}
        This was your previous work (but I haven't seen any of it! I only see what you return as final answer):
        {agent_scratchpad}`),
  ]);

  const llmChain = new LLMChain({
    prompt: createBodyPrompt,
    llm: chat,
  });

  const agent = new ZeroShotAgent({
    llmChain,
    allowedTools: tools.map((tool) => tool.name),
  });

  const executor = AgentExecutor.fromAgentAndTools({ agent, tools });

  const task = `Email sender:${sender}\nEmail subject:${subject}\nEmail history:${body}\n`;
  try {
    const response = await executor.run(task);
    //todo: add usage
    return {
      text: response,
      usage: 0,
    };
  } catch (error) {
    console.log({ error });
    if (error.message.includes("Could not parse LLM output:")) {
      return {
        text: error.message.replace("Could not parse LLM output:", ""),
        usage: 0,
      };
    }
    return {
      text: "I am sorry, I could not finish your request in time. Please try again later.",
      usage: 0,
    };
  }
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
