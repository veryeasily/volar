import type { TsApiRegisterOptions } from '../types';
import {
	Position,
	CompletionItem,
	CompletionList,
	TextEdit,
	CompletionItemKind,
	Range,
} from 'vscode-languageserver-types';
import { CompletionContext } from 'vscode-languageserver/node';
import { SourceFile } from '../sourceFile';
import { CompletionData } from '../types';
import { transformCompletionItem } from '@volar/source-map';
import { transformCompletionList } from '@volar/source-map';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { hyphenate, isGloballyWhitelisted } from '@vue/shared';
import { languageIdToSyntax, getWordStart } from '@volar/shared';
import * as html from 'vscode-html-languageservice';
import * as languageServices from '../utils/languageServices';
import * as emmet from 'vscode-emmet-helper';
import * as getEmbeddedDocument from './embeddedDocument';
import type * as ts from 'typescript';

export const triggerCharacter = {
	typescript: [".", "\"", "'", "`", "/", "@", "<", "#"],
	html: ['<', ':', '@'],
	css: ['.', '@'],
};
export const wordPatterns: { [lang: string]: RegExp } = {
	css: /(#?-?\d*\.\d\w*%?)|(::?[\w-]*(?=[^,{;]*[,{]))|(([@#.!])?[\w-?]+%?|[@#!.])/g,
	less: /(#?-?\d*\.\d\w*%?)|(::?[\w-]+(?=[^,{;]*[,{]))|(([@#.!])?[\w-?]+%?|[@#!.])/g,
	scss: /(#?-?\d*\.\d\w*%?)|(::?[\w-]*(?=[^,{;]*[,{]))|(([@$#.!])?[\w-?]+%?|[@#!$.])/g,
	postcss: /(#?-?\d*\.\d\w*%?)|(::?[\w-]*(?=[^,{;]*[,{]))|(([@$#.!])?[\w-?]+%?|[@#!$.])/g, // scss
};
export const vueTags = [
	{
		name: 'template',
		attributes: [
			{
				name: 'lang',
				values: [
					{ name: 'html' },
					{ name: 'pug' },
				],
			},
		],
	},
	{
		name: 'script',
		attributes: [
			{
				name: 'lang',
				values: [
					{ name: 'js' },
					{ name: 'ts' },
					{ name: 'jsx' },
					{ name: 'tsx' },
				],
			},
			{ name: 'setup' },
		],
	},
	{
		name: 'style',
		attributes: [
			{
				name: 'lang',
				values: [
					{ name: 'css' },
					{ name: 'scss' },
					{ name: 'less' },
				],
			},
			{ name: 'scoped' },
			{ name: 'module' },
		],
	},
];

export function register({ sourceFiles, tsLanguageService }: TsApiRegisterOptions) {
	const getEmbeddedDoc = getEmbeddedDocument.register(arguments[0]);

	return async (document: TextDocument, position: Position, context?: CompletionContext, getEmmetConfig?: (syntax: string) => emmet.VSCodeEmmetConfig) => {
		const sourceFile = sourceFiles.get(document.uri);
		if (!sourceFile) return;

		const tsResult = getTsResult(sourceFile);
		if (tsResult) return tsResult;

		const emmetResult = getEmmetResult();

		// precede html for support inline css service
		const cssResult = getCssResult(sourceFile);
		if (cssResult) return withEmmetResult(cssResult, emmetResult);

		const htmlResult = getHtmlResult(sourceFile);
		if (htmlResult) return withEmmetResult(htmlResult, emmetResult);

		const vueResult = getVueResult(sourceFile);
		if (vueResult) return withEmmetResult(vueResult, emmetResult);

		return emmetResult;

		function withEmmetResult(a: CompletionList, b?: CompletionList): CompletionList {
			return {
				isIncomplete: a.isIncomplete,
				items: b ? a.items.concat(b.items) : a.items,
			};
		}
		function getTsResult(sourceFile: SourceFile) {
			let result: CompletionList | undefined = undefined;
			if (context?.triggerCharacter && !triggerCharacter.typescript.includes(context.triggerCharacter)) {
				return result;
			}
			for (const sourceMap of sourceFile.getTsSourceMaps()) {
				const tsRanges = sourceMap.sourceToTargets(position);
				for (const tsRange of tsRanges) {
					if (!tsRange.data.capabilities.completion) continue;
					if (!result) {
						result = {
							isIncomplete: false,
							items: [],
						};
					}
					const quotePreference = tsRange.data.vueTag === 'template' ? 'single' : 'auto';
					let tsItems = tsLanguageService.doComplete(sourceMap.targetDocument.uri, tsRange.start, {
						quotePreference,
						includeCompletionsForModuleExports: ['script', 'scriptSetup'].includes(tsRange.data.vueTag ?? ''), // TODO: read ts config
						triggerCharacter: context?.triggerCharacter as ts.CompletionsTriggerCharacter,
					});
					if (tsRange.data.vueTag === 'template') {
						tsItems = tsItems.filter(tsItem => {
							const sortText = Number(tsItem.sortText);
							if (Number.isNaN(sortText))
								return true;
							if (sortText < 4)
								return true;
							if (isGloballyWhitelisted(tsItem.label))
								return true;
							return false;
						});
					}
					const vueItems: CompletionItem[] = tsItems.map(tsItem => {
						const data: CompletionData = {
							uri: document.uri,
							docUri: sourceMap.targetDocument.uri,
							mode: 'ts',
							tsItem: tsItem,
						};
						const vueItem = transformCompletionItem(tsItem, sourceMap);
						vueItem.data = data;
						return vueItem;
					});
					result.items = result.items.concat(vueItems);
				}
			}
			if (result) {
				result.items = result.items.filter(result => result.label.indexOf('__VLS_') === -1);
			}
			return result;
		}
		function getHtmlResult(sourceFile: SourceFile) {
			let result: CompletionList | undefined = undefined;
			if (context?.triggerCharacter && !triggerCharacter.html.includes(context.triggerCharacter)) {
				return;
			}
			for (const sourceMap of [...sourceFile.getHtmlSourceMaps(), ...sourceFile.getPugSourceMaps()]) {
				const componentCompletion = sourceFile.getComponentCompletionData();
				const tags: html.ITagData[] = [];
				const tsItems = new Map<string, CompletionItem>();
				const globalAttributes: html.IAttributeData[] = [
					// TODO: hardcode
					{ name: 'v-if' },
					{ name: 'v-else-if' },
					{ name: 'v-else' },
					{ name: 'v-for' },
				];
				const slots: html.IAttributeData[] = [];
				for (const [componentName, { item, bind, on, slot }] of componentCompletion) {
					if (componentName === '*') {
						for (const prop of bind) {
							const name: string = prop.data.name;
							if (name.length > 2 && hyphenate(name).startsWith('on-')) {
								const propName = '@' + hyphenate(name).substr('on-'.length);
								const propKey = componentName + ':' + propName;
								globalAttributes.push({
									name: propName,
									description: propKey,
								});
								tsItems.set(propKey, prop);
							}
							else {
								const propName = ':' + hyphenate(name);
								const propKey = componentName + ':' + propName;
								globalAttributes.push({
									name: propName,
									description: propKey,
								});
								tsItems.set(propKey, prop);
							}
						}
					}
					else {
						const attributes: html.IAttributeData[] = [];
						for (const prop of bind) {
							const name: string = prop.data.name;
							if (name.length > 2 && hyphenate(name).startsWith('on-')) {
								const propName = '@' + hyphenate(name).substr('on-'.length);
								const propKey = componentName + ':' + propName;
								attributes.push({
									name: propName,
									description: propKey,
								});
								tsItems.set(propKey, prop);
							}
							else {
								const propName = ':' + hyphenate(name);
								const propKey = componentName + ':' + propName;
								attributes.push({
									name: propName,
									description: propKey,
								});
								tsItems.set(propKey, prop);
							}
						}
						for (const event of on) {
							const propName = '@' + event.data.name;
							const propKey = componentName + ':' + propName;
							attributes.push({
								name: propName,
								description: propKey,
							});
							tsItems.set(propKey, event);
						}
						for (const _slot of slot) {
							const propName = '#' + _slot.data.name;
							const propKey = componentName + ':' + propName;
							slots.push({
								name: propName,
								description: propKey,
							});
							tsItems.set(propKey, _slot);
						}
						if (item) {
							tags.push({
								name: componentName,
								description: componentName + ':',
								attributes,
							});
							tsItems.set(componentName + ':', item);
						}
						else {
							tags.push({
								name: componentName,
								attributes,
							});
						}
					}
				}
				tags.push({
					name: 'template',
					attributes: slots,
				});
				const dataProvider = html.newHTMLDataProvider(document.uri, {
					version: 1.1,
					tags,
					globalAttributes,
				});
				languageServices.html.setDataProviders(true, [dataProvider]);

				for (const htmlRange of sourceMap.sourceToTargets(position)) {
					if (!result) {
						result = {
							isIncomplete: false,
							items: [],
						};
					}
					const htmlResult = sourceMap.language === 'html'
						? languageServices.html.doComplete(sourceMap.targetDocument, htmlRange.start, sourceMap.htmlDocument)
						: languageServices.pug.doComplete(sourceMap.pugDocument, htmlRange.start)
					if (!htmlResult) continue;
					if (htmlResult.isIncomplete) {
						result.isIncomplete = true;
					}
					let vueItems = htmlResult.items.map(htmlItem => transformCompletionItem(htmlItem, sourceMap));
					const htmlItemsMap = new Map<string, html.CompletionItem>();
					for (const entry of htmlResult.items) {
						htmlItemsMap.set(entry.label, entry);
					}
					for (const vueItem of vueItems) {
						const documentation = typeof vueItem.documentation === 'string' ? vueItem.documentation : vueItem.documentation?.value;
						const tsItem = documentation ? tsItems.get(documentation) : undefined;
						if (tsItem) {
							vueItem.documentation = undefined;
						}
						if (vueItem.label.startsWith(':')) {
							vueItem.sortText = '\u0000' + vueItem.sortText;
						}
						else if (vueItem.label.startsWith('@')) {
							vueItem.sortText = '\u0001' + vueItem.sortText;
						}
						if (tsItem && !documentation?.startsWith('*:')) { // not globalAttributes
							vueItem.sortText = '\u0000' + vueItem.sortText;
							vueItem.kind = CompletionItemKind.Field;
						}
						else if (vueItem.label.startsWith('v-')) {
							vueItem.kind = CompletionItemKind.Method;
							vueItem.sortText = '\u0002' + vueItem.sortText;
						}
						else {
							vueItem.sortText = '\u0001' + vueItem.sortText;
						}
						const data: CompletionData = {
							mode: 'html',
							uri: document.uri,
							docUri: sourceMap.targetDocument.uri,
							tsItem: tsItem,
						};
						vueItem.data = data;
					}
					{ // filter HTMLAttributes
						const temp = new Map<string, CompletionItem>();
						for (const item of vueItems) {
							if (!temp.get(item.label)?.documentation) {
								temp.set(item.label, item);
							}
						}
						vueItems = [...temp.values()];
					}
					result.items = result.items.concat(vueItems);
				}
			}
			return result;
		}
		function getCssResult(sourceFile: SourceFile) {
			let result: CompletionList | undefined = undefined;
			if (context?.triggerCharacter && !triggerCharacter.css.includes(context.triggerCharacter)) {
				return;
			}
			for (const sourceMap of sourceFile.getCssSourceMaps()) {
				const cssRanges = sourceMap.sourceToTargets(position);
				for (const cssRange of cssRanges) {
					if (!result) {
						result = {
							isIncomplete: false,
							items: [],
						};
					}
					const cssLanguageService = languageServices.getCssLanguageService(sourceMap.targetDocument.languageId);
					if (!cssLanguageService || !sourceMap.stylesheet) continue;
					const wordPattern = wordPatterns[sourceMap.targetDocument.languageId] ?? wordPatterns.css;
					const wordStart = getWordStart(wordPattern, cssRange.end, sourceMap.targetDocument);
					const wordRange: Range = wordStart ? { start: wordStart, end: cssRange.end } : cssRange;
					const cssResult = cssLanguageService.doComplete(sourceMap.targetDocument, cssRange.start, sourceMap.stylesheet);
					if (cssResult.isIncomplete) {
						result.isIncomplete = true;
					}
					const data: CompletionData = {
						uri: document.uri,
						docUri: sourceMap.targetDocument.uri,
						mode: 'css',
					};
					const vueItems: CompletionItem[] = cssResult.items.map(cssItem => {
						const newText = cssItem.textEdit?.newText || cssItem.insertText || cssItem.label;
						cssItem.textEdit = TextEdit.replace(wordRange, newText);
						const vueItem = transformCompletionItem(cssItem, sourceMap);
						vueItem.data = data;
						return vueItem;
					}
					);
					result.items = result.items.concat(vueItems);
				}
			}
			return result;
		}
		function getVueResult(sourceFile: SourceFile) {
			const embededDoc = getEmbeddedDoc(document, { start: position, end: position });
			if (embededDoc) {
				let syntax = languageIdToSyntax(embededDoc.document.languageId);
				if (syntax === 'vue') {
					const dataProvider = html.newHTMLDataProvider(document.uri, {
						version: 1.1,
						tags: vueTags,
					});
					languageServices.html.setDataProviders(false, [dataProvider]);
					const vueHtmlDoc = sourceFile.getVueHtmlDocument();
					return languageServices.html.doComplete(document, position, vueHtmlDoc);
				}
			}
		}
		function getEmmetResult() {
			if (!getEmmetConfig) return;
			const embededDoc = getEmbeddedDoc(document, { start: position, end: position });
			if (embededDoc) {
				const emmetConfig = getEmmetConfig(embededDoc.document.languageId);
				if (emmetConfig) {
					let syntax = languageIdToSyntax(embededDoc.document.languageId);
					if (syntax === 'vue') syntax = 'html';
					const emmetResult = emmet.doComplete(embededDoc.document, embededDoc.range.start, syntax, emmetConfig);
					if (emmetResult && embededDoc.sourceMap) {
						return transformCompletionList(emmetResult, embededDoc.sourceMap);
					}
					return emmetResult;
				}
			}
		}
	}
}
