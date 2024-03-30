
import * as vscode from 'vscode';

import * as os from 'os';
import { promises as fs } from 'fs';

import * as path from 'path';
import * as crypto from 'crypto';

import * as dotenv from 'dotenv';
import sharp from 'sharp';
import OpenAI from 'openai';

const VISION_PARTICIPANT_ID = 'vision-participant.particpant';
const CHAT_ABOUT_IMAGE_COMMAND_ID = 'vision-participant.chatCommand';
const PREVIEW_COMMAND_ID = 'vision-participant.previewCommand';

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

interface VisionChatResult extends vscode.ChatResult {
	result: string;
}

// Enable that the OPENAI_API_KEY can also be set in ~/.env
dotenv.config({ path: `${os.homedir()}/.env` });

const openai = new OpenAI();

export function activate(context: vscode.ExtensionContext) {

	const handler: vscode.ChatRequestHandler = async (request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<VisionChatResult> => {
		if (request.prompt === '') {
			stream.markdown('Enter a question about an image.');
			return { result: '' };
		}

		let [filePath, finalPrompt] = extractImagePathFromPrompt(request.prompt);
		if (!filePath) {
			let fileUri = await vscode.window.showOpenDialog({
				canSelectMany: false,
				filters: {
					'Images': ['png']
				}
			});
			if (!fileUri || !fileUri[0]) {
				return { result: '' };
			}
			filePath = fileUri[0].fsPath;
		}

		let [imageDataURL, smallImagePath] = await processImage(filePath);
		if (!imageDataURL || !smallImagePath) {
			return { result: '', errorDetails: { message: 'Failed to process the image.' } };
		}

		stream.markdown(`\n![image](file://${smallImagePath})\n`);

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
							text: `${finalPrompt}`
						},
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

		let responseText = '';

		for await (const part of response) {
			const delta = part.choices[0]?.delta?.content || '';
			responseText += delta;
			stream.markdown(delta);
		}

		// show preview button if there is a single html code block
		if (responseText.length > 0) {
			let codeBlocks = extractAllMarkdownCodeBlocks(responseText);
			if (codeBlocks.length === 1) {
				let language = getLanguageFromMarkdownCodeBlock(codeBlocks[0]);
				if (language === 'html') {
					stream.button({
						command: PREVIEW_COMMAND_ID,
						arguments: [codeBlocks[0]],
						title: vscode.l10n.t('Preview')
					});
				}
			}
		}
		return { result: responseText };
	}

	const visionParticipant = vscode.chat.createChatParticipant(VISION_PARTICIPANT_ID, handler);
	visionParticipant.iconPath = new vscode.ThemeIcon('eye');

	context.subscriptions.push(
		visionParticipant,
		vscode.commands.registerCommand(CHAT_ABOUT_IMAGE_COMMAND_ID, chatAboutImage),
		vscode.commands.registerCommand(PREVIEW_COMMAND_ID, showPreview),
	);

	function extractImagePathFromPrompt(prompt: string): [string | undefined, string | undefined] {
		const imagePathRegex = /#image:\S+/;
		const match = prompt.match(imagePathRegex);
		if (match) {
			const filePath = match[0].replace('#image:', '');
			const finalPrompt = prompt.replace(match[0], '');
			return [filePath, finalPrompt];
		} else {
			return [undefined, prompt];
		}
	}

	async function processImage(filePath: string): Promise<[string | undefined, string | undefined]> {
		let smallImagePath;
		let imageDataURL;
		try {
			let imageBuffer;
			imageBuffer = await fs.readFile(filePath);
			imageDataURL = await getDataURL(imageBuffer);
			if (!imageDataURL) {
				return [undefined, undefined];
			}
			smallImagePath = await createSmallImage(imageBuffer);
		} catch (err) {
			return [undefined, undefined]
		};
		return [imageDataURL, smallImagePath]
	}

	async function showPreview(arg: string): Promise<void> {
		let htmlSource = removeFirstAndLastLine(arg);
		// TODO Hack
		let workspacePath = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
		const filePath = path.join(workspacePath!, 'preview.html');
		await fs.writeFile(filePath, htmlSource);
		const uri = vscode.Uri.file(filePath);
		await vscode.commands.executeCommand('vscode.open', uri);
		// using https://marketplace.visualstudio.com/items?itemName=ms-vscode.live-server
		await vscode.commands.executeCommand('livePreview.start.preview.atFile');
		// using live server extension: https://marketplace.visualstudio.com/items?itemName=ritwickdey.LiveServer
		// await vscode.commands.executeCommand('extension.liveServer.goOnline');
	}

	async function chatAboutImage(): Promise<void> {
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
		// The editors showing a png file are custom editors. Therefore
		// get the file path from the active tab
		let tab = vscode.window.tabGroups.activeTabGroup.activeTab;
		if (tab) {
			if (tab.input instanceof vscode.TabInputCustom) {
				return tab.input.uri.fsPath;
			}
		}
		return undefined
	}

	async function getDataURL(imageBuffer: Buffer): Promise<string> {
		let buffer = await sharp(imageBuffer).toBuffer();
		let base64Image = buffer.toString('base64');
		let dataUrl = 'data:image/png;base64,' + base64Image;
		return dataUrl;
	}

	async function createSmallImage(imageBuffer: Buffer): Promise<string> {
		const tempFileWithoutExtension = await getTmpFileName();
		const smallFilePath = tempFileWithoutExtension + '-small.png';

		await sharp(imageBuffer)
			.resize({ width: 400 })
			.toFile(smallFilePath);
		return smallFilePath;
	}

	async function getTmpFileName(): Promise<string> {
		const randomFileName = crypto.randomBytes(20).toString('hex');
		const tempFileWithoutExtension = path.join(os.tmpdir(), VISION_PARTICIPANT_TMP_DIR, `${randomFileName}`);
		const tempDir = path.dirname(tempFileWithoutExtension);
		try {
			await fs.access(tempDir);
		} catch (err) {
			await fs.mkdir(tempDir, { recursive: true });
		}
		return tempFileWithoutExtension;
	}

	function extractAllMarkdownCodeBlocks(markdown: string): string[] {
		const codeBlockRegex = /```[\s\S]*?```/g;
		const codeBlocks = markdown.match(codeBlockRegex);
		return codeBlocks || [];
	}

	function getLanguageFromMarkdownCodeBlock(codeBlock: string): string | null {
		const languageRegex = /```(\S*)[\s\S]*?```/;
		const match = codeBlock.match(languageRegex);
		return match && match[1] ? match[1] : null;
	}

	function removeFirstAndLastLine(text: string): string {
		const lines = text.split('\n');
		lines.shift();
		lines.pop();
		return lines.join('\n');
	}
}

export function deactivate() { }
