
import * as vscode from 'vscode';

import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

import * as dotenv from 'dotenv';
import sharp from 'sharp';
import OpenAI from 'openai';

const VISION_PARTICIPANT_ID = 'vision-participant.particpant';
const CHAT_ABOUT_IMAGE_COMMAND_ID = 'vision-participant.chatCommand';
const VISION_PARTICIPANT_TMP_DIR = 'vison-participant';

const SYSTEM_MESSAGE =
	`You are a world class programmer.\n` +
	`You help a programmer to answer programming questions.\n` +
	`Please be concise and provide an answer and include code as needed.` +
	// Format restrictions
	`Answer the query in a freeform markdown-formatted response` +
	`Restrict the format used in your answers as follows:\n` +
	`1. Use Markdown formatting in your answers.\n` +
	`2. Make sure to include the programming language name at the start of the Markdown code blocks.\n` +
	`3. Avoid wrapping the whole response in triple backticks.\n`;

// OPENAI_API_KEY can also be set in ~/.env
dotenv.config({ path: `${os.homedir()}/.env` });

const openai = new OpenAI();

export function activate(context: vscode.ExtensionContext) {

	const handler: vscode.ChatRequestHandler = async (request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<vscode.ChatResult> => {
		if (request.prompt === '') {
			stream.markdown('Enter the question about an image that you will then select.');
			return {};
		}
		let finalPrompt = request.prompt;
		let filePath = '';

		// Check if the prompt contains an image path
		// example: some text #image:src/sample.png some more text'
		const imagePathRegex = /#image:\S+/;
		const match = request.prompt.match(imagePathRegex);

		if (match) {
			filePath = match[0].replace('#image:', '');
			// remove the path variable
			finalPrompt = request.prompt.replace(match[0], '');
		} else {
			let fileUri = await vscode.window.showOpenDialog({
				canSelectMany: false,
				filters: {
					'Images': ['png']
				}
			});

			if (!fileUri || !fileUri[0]) {
				return {};
			}
			filePath = fileUri[0].fsPath;
		}

		let imageBuffer = fs.readFileSync(filePath);
		const imageDataURL = await getDataURL(imageBuffer);
		const smallImagePath = await createSmallImage(imageBuffer);
		stream.markdown(`\n![image](file://${smallImagePath})\n\n`);

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
						{ 
							type: "text", 
							text: `${finalPrompt}` },
						{
							type: "image_url",
							image_url: {
								"url": imageDataURL,
							},
						},
					],
				},
			],
			stream: true,
			max_tokens: 800,
		});

		for await (const part of response) {
			stream.markdown(part.choices[0]?.delta?.content || '');
		}

		return {};
	}

	const visionParticipant = vscode.chat.createChatParticipant(VISION_PARTICIPANT_ID, handler);
	visionParticipant.iconPath = new vscode.ThemeIcon('eye');

	context.subscriptions.push(
		visionParticipant,
		vscode.commands.registerCommand(CHAT_ABOUT_IMAGE_COMMAND_ID, chatAboutImage)
	);

	async function chatAboutImage() {
		let filePath = getFilePathOfImage();

		const commandId = 'workbench.action.chat.open';
		const options = {
			query: `@vision #image:${filePath} `,
			isPartialQuery: true
		};
		await vscode.commands.executeCommand(commandId, options);
	}

	function getFilePathOfImage(): string | undefined {
		const editor = vscode.window.activeTextEditor;
		if (editor) {
			return editor.document.uri.fsPath;
		}
		let tab = vscode.window.tabGroups.activeTabGroup.activeTab;
		if (tab) {
			if (tab.input instanceof vscode.TabInputCustom) {
				return tab.input.uri.fsPath;
			}
		}
		return undefined
	}

	async function getDataURL(imageBuffer: Buffer): Promise<string> {
		try {
			let buffer = await sharp(imageBuffer).toBuffer();
			let base64Image = buffer.toString('base64');
			let dataUrl = 'data:image/png;base64,' + base64Image;
			return dataUrl;
		} catch (err) {
			console.error(err);
		}
		return '';
	}

	async function createSmallImage(imageBuffer: Buffer): Promise<string> {
		const tempFileWithoutExtension = getTmpFileName();
		const smallFilePath = tempFileWithoutExtension + '-small.png';

		await sharp(imageBuffer)
			.resize({ width: 400 })
			.toFile(smallFilePath);
		return smallFilePath;
	}

	function getTmpFileName(): string {
		const randomFileName = crypto.randomBytes(20).toString('hex');
		const tempFileWithoutExtension = path.join(os.tmpdir(), VISION_PARTICIPANT_TMP_DIR, `${randomFileName}`);
		const tempDir = path.dirname(tempFileWithoutExtension);
		fs.mkdirSync(tempDir, { recursive: true });
		return tempFileWithoutExtension;
	}
}

export function deactivate() { }
