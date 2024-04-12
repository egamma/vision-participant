
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

// Enable that the OPENAI_API_KEY can also be set in ~/.env
dotenv.config({ path: `${os.homedir()}/.env` });

const openai = new OpenAI();

class ChatImage {

	constructor(
		public imagePath: string | undefined = undefined,
		public promptWithoutVariable: string | undefined = undefined,
		public dataURL: string | undefined = undefined,
		public smallImagePath: string | undefined = undefined,
		public errorMessage: string | undefined = undefined
	) { }

 public async createImageFromPrompt(request: vscode.ChatRequest) {
 	this.extractImagePathFromPrompt(request);
 	if (!this.imagePath) {
 		let fileUri = await vscode.window.showOpenDialog({
 			canSelectMany: false,
 			filters: {
 				'Images': ['png', 'jpg', 'jpeg']
 			}
 		});
 		if (!fileUri || !fileUri[0]) {
 			this.imagePath = undefined;
 			return;
 		}
 		this.imagePath = fileUri[0].fsPath;
 	}
 	await this.processImage(this.imagePath);
 }

	private extractImagePathFromPrompt(request: vscode.ChatRequest) {
		const fileVariable = request.variables?.find(variable => variable.name.startsWith('file'));
		if (fileVariable) {
			const s = request.prompt;
			const start = fileVariable.range![0];
			const end = fileVariable.range![1];
			this.imagePath = (fileVariable.values[0].value as vscode.Uri).fsPath;
			this.promptWithoutVariable = s.substring(0, start) + s.substring(end);
		} else {
			const imagePathRegex = /#image:\S+/;
			const match = request.prompt.match(imagePathRegex);
			if (match) {
				this.imagePath = match[0].replace('#image:', '');
				if (!path.isAbsolute(this.imagePath)) {
					this.imagePath = this.getAbsolutePath(this.imagePath) || this.imagePath;
				}
				this.promptWithoutVariable = request.prompt.replace(match[0], '');
			} else {
				this.promptWithoutVariable = request.prompt;
			}
		}
	}

	private async processImage(filePath: string) {
		try {
			let imageBuffer;
			imageBuffer = await fs.readFile(filePath);
			if (this.imagePath) {
			    this.dataURL = await this.getDataURL(imageBuffer, this.imagePath);
			}
			if (!this.dataURL) {
				return;
			}
			this.smallImagePath = await this.createSmallImage(imageBuffer);
		} catch (err) {
			if (err instanceof Error) {
				this.errorMessage = err.message;
			} else {
				this.errorMessage = 'unkown error';
			}
		};
	}

 private async getDataURL(imageBuffer: Buffer, imagePath: string): Promise<string> {
     let buffer = await sharp(imageBuffer).toBuffer();
     let base64Image = buffer.toString('base64');
     let mimeType = 'image/png'; // Default MIME type
     if (imagePath.endsWith('.jpg') || imagePath.endsWith('.jpeg')) {
         mimeType = 'image/jpeg';
     }
     let dataUrl = `data:${mimeType};base64,${base64Image}`;
     return dataUrl;
 }

 private async createSmallImage(imageBuffer: Buffer): Promise<string> {
     const tempFileWithoutExtension = await this.getTmpFileName();
     let extension = '.png'; // Default to .png if no imagePath is provided
     if (this.imagePath) {
         const imagePathLower = this.imagePath.toLowerCase();
         if (imagePathLower.endsWith('.jpg') || imagePathLower.endsWith('.jpeg')) {
             extension = '.jpg';
         } else if (imagePathLower.endsWith('.png')) {
             extension = '.png';
         }
     }
     const smallFilePath = tempFileWithoutExtension + '-small' + extension;

     try {
         await sharp(imageBuffer)
             .resize({ width: 400 })
             .toFile(smallFilePath);
         return smallFilePath;
     } catch (error) {
         this.errorMessage = `Failed to create small image: ${error}`;
         return '';
     }
 }

	private async getTmpFileName(): Promise<string> {
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

	private getAbsolutePath(relativePath: string): string | undefined {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (workspaceFolder) {
			return path.join(workspaceFolder.uri.fsPath, relativePath);
		}
		return undefined;
	}
}

interface VisionChatResult extends vscode.ChatResult {
	result: string;
}

class VisionChatCodeBlocks {
	private codeBlocks: string[] = [];

	constructor(response: string) {
		this.codeBlocks = this.extractAllMarkdownCodeBlocks(response);
	}

	numberOfCodeBlocks(): number {
		return this.codeBlocks.length;
	}

	getBlockLanguage(index: number): string | null {
		let codeBlock = this.codeBlocks[index];
		const languageRegex = /```(\S*)[\s\S]*?```/;
		const match = codeBlock.match(languageRegex);
		return match && match[1] ? match[1] : null;
	}

	getPlainBlock(index: number): string {
		let block = this.codeBlocks[index];
		// remove first and last line
		const lines = block.split('\n');
		lines.shift();
		lines.pop();
		return lines.join('\n');
	}

	private extractAllMarkdownCodeBlocks(markdown: string): string[] {
		const codeBlockRegex = /```[\s\S]*?```/g;
		const codeBlocks = markdown.match(codeBlockRegex);
		return codeBlocks || [];
	}
}

export function activate(context: vscode.ExtensionContext) {

	const handler: vscode.ChatRequestHandler = async (request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<VisionChatResult> => {
		if (request.prompt === '') {
			stream.markdown('Enter a question about an image.');
			return { result: '' };
		}

		let chatImage = new ChatImage();
		await chatImage.createImageFromPrompt(request);
		if (!chatImage.imagePath) {
			return { result: '' };
		}
		if (!chatImage.dataURL) {
			return { result: '', errorDetails: { message: `Failed to process the image (${chatImage.errorMessage}).` } };
		}

		stream.markdown(`\n![image](file://${chatImage.smallImagePath})  \n`);

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
							text: `${chatImage.promptWithoutVariable}`
						},
						{
							type: "image_url",
							image_url: {
								"url": chatImage.dataURL,
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

		if (responseText.length > 0) {
			let codeBlocks = new VisionChatCodeBlocks(responseText);
			// show preview button if there is a single html code block
			if (codeBlocks.numberOfCodeBlocks() === 1 && codeBlocks.getBlockLanguage(0) === 'html') {
				stream.button({
					command: PREVIEW_COMMAND_ID,
					arguments: [codeBlocks.getPlainBlock(0)],
					title: vscode.l10n.t('Preview')
				});
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

	/*
	* Commands
	*/
	async function showPreview(arg: string): Promise<void> {
		let htmlSource = arg;

		// TODO Hack for creating a temporary file and opening it in the browser
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
		const isMultiRoot = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 1
		const pathType = isMultiRoot ? PathType.Absolute : PathType.Relative;
		let path = getImagePathFromWindow(pathType);

		const commandId = 'workbench.action.chat.open';
		const options = {
			query: `@vision #image:${path} `,
			isPartialQuery: true
		};
		await vscode.commands.executeCommand(commandId, options);
	}
}

enum PathType {
	Absolute = 'absolute',
	Relative = 'relative'
}

function getImagePathFromWindow(type: PathType): string | undefined {
	let uri;
	const editor = vscode.window.activeTextEditor;
	if (editor) {
		uri = editor.document.uri;
	} else {
		// The editors showing an image file are custom editors. Therefore
		// get the file path from the active tab
		let tab = vscode.window.tabGroups.activeTabGroup.activeTab;
		if (tab) {
			if (tab.input instanceof vscode.TabInputCustom) {
				uri = tab.input.uri;
			}
		}
	}
	if (uri) {
		if (type === PathType.Relative) {
			return vscode.workspace.asRelativePath(uri.fsPath);
		}
		return uri.fsPath;
	}
	return undefined
}

export function deactivate() { }
