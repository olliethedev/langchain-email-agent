import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';

import { VERIFIED_SES_EMAIL, OPENAI_API_KEY, INFO_WEBSITE } from '../env';


export class LangchainEmailAgentStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Define the S3 bucket
    const myBucket = new s3.Bucket(this, 'MyLangchainSesBucket');

    // Define the Lambda function
    const myLambda = new lambda.Function(this, 'MyLangchainSesLambda', {
      code: lambda.Code.fromAsset('lambda'), // lambda code is in 'lambda' directory
      handler: 'index.handler', // exports.handler in your index.js file
      runtime: lambda.Runtime.NODEJS_18_X, // Use Node.js 18.x runtime
      timeout: cdk.Duration.seconds(60*10), // 10 minutes timeout
      retryAttempts: 0, // no retries
      reservedConcurrentExecutions: 1, // only 1 concurrent execution. Todo: use a better solution to prevent spamming
      environment: {
        BUCKET_NAME: myBucket.bucketName, // pass in the bucket name as an environment variable
        OPENAI_API_KEY: OPENAI_API_KEY, // pass in the OpenAI API key as an environment variable
        SES_EMAIL: VERIFIED_SES_EMAIL, // pass in the verified SES email as an environment variable
        INFO_SOURCE: INFO_WEBSITE // pass in the info source as an environment variable
      },
    });

    
    // Allow lambda to read from S3 bucket
    myBucket.grantRead(myLambda);

    // Define SES Rule
    const mySesRule = new ses.CfnReceiptRuleSet(this, 'MyLangchainSesRuleSet', {
      ruleSetName: 'MyRuleSet',
    });

    new ses.CfnReceiptRule(this, 'MyLangchainSesRule', {
      rule: {
        name: 'MyRule',
        enabled: true,
        recipients: [VERIFIED_SES_EMAIL], // replace with your email
        actions: [
          {
            s3Action: {
              bucketName: myBucket.bucketName,
              objectKeyPrefix: 'emails/', // optional prefix for stored emails
            }
          },
          {
            lambdaAction: {
              functionArn: myLambda.functionArn,
              invocationType: 'Event'
            }
          }
        ]
      },
      ruleSetName: mySesRule.ruleSetName as string
    });

    // Allow SES to invoke the lambda function
    myLambda.addPermission('AllowSESToInvoke', {
      action: 'lambda:InvokeFunction',
      principal: new iam.ServicePrincipal('ses.amazonaws.com') 
    });

    // Allow lambda to send email
    myLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'ses:SendEmail',
        'ses:SendRawEmail',
        'ses:SendTemplatedEmail',
      ],
      resources: [
        `arn:aws:ses:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:identity/${VERIFIED_SES_EMAIL}`,
      ],
    }));

    // Allow ses to write to S3 bucket
    myBucket.grantPut(new iam.ServicePrincipal('ses.amazonaws.com'));


  }
}
