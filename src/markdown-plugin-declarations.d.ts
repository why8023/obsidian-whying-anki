/**
 * 为 `markdown-it-task-lists` 提供本地类型声明。
 * 这个依赖本身没有内置 TypeScript 定义，所以插件需要手动补一个最小声明文件。
 */
declare module "markdown-it-task-lists" {
	import type MarkdownIt from "markdown-it";

	interface TaskListOptions {
		enabled?: boolean;
		label?: boolean;
		labelAfter?: boolean;
	}

	const plugin: MarkdownIt.PluginWithOptions<TaskListOptions>;

	export default plugin;
}
