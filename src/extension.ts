
import * as vscode from 'vscode';
import * as os from 'os';
import * as fs from 'fs';

import * as dotenv from 'dotenv';
import sharp from 'sharp';

import OpenAI from 'openai';

const VISION_PARTICIPANT_ID = 'chat-participant.vision';

// prompts
const SYSTEM_MESSAGE =
	`You are a world class programmer.\n` +
	`You help a programmer to answer programming questions.\n` +
	`Please be concise and provide an answer and include code as needed.` +
	`Answer the query in a freeform markdown-formatted response` +
	`Restrict the format used in your answers as follows:\n` +
	`1. Use Markdown formatting in your answers.\n` +
	`2. Make sure to include the programming language name at the start of the Markdown code blocks.\n` +
	`3. Avoid wrapping the whole response in triple backticks.\n` ;

// OPENAI_API_KEY can also be set in ~/.env
dotenv.config({ path: `${os.homedir()}/.env` });

const sample = '/Users/egamma/Projects/vision-participant/sample.png';

export function activate(context: vscode.ExtensionContext) {

	const handler: vscode.ChatRequestHandler = async (request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<vscode.ChatResult> => {
		console.log('Request:', request);

		const openai = new OpenAI();
		const imageURL = await getDataURL(sample);
		
		const response = await openai.chat.completions.create({
			model: "gpt-4-vision-preview",
			messages: [
				{
					role: "system",
					content: SYSTEM_MESSAGE
				},
				{
					role: "user",
					content: [
						{ type: "text", text: `${request.prompt}` },
						{
							type: "image_url",
							image_url: {
								"url": imageURL,
							},
						},
					],
				},
			],
			stream: true,
			max_tokens: 700,
		});

		for await (const part of response) {
			stream.markdown(part.choices[0]?.delta?.content || '');
		}
		return {};
	}

	const visionParticipant = vscode.chat.createChatParticipant(VISION_PARTICIPANT_ID, handler);
	visionParticipant.iconPath = new vscode.ThemeIcon('eye');

	context.subscriptions.push(
		visionParticipant
	);

	async function getDataURL(path: string): Promise<string> {
		let imageBuffer = fs.readFileSync(path);
		try {
			let buffer = await sharp(imageBuffer).toBuffer();
			let base64Image = buffer.toString('base64');

			// Construct the data URL
			let dataUrl = 'data:image/png;base64,' + base64Image;

			console.log(dataUrl);
			return dataUrl;
		} catch (err) {
			console.error(err);
		}
		return '';
	}
}

export function deactivate() { }
