class TextPart { constructor(v){ this.value=v; } }
class ToolCallPart { constructor(i,n,x){ this.callId=i; this.name=n; this.input=x; } }
class ToolResultPart { constructor(i,c){ this.callId=i; this.content=c; } }
class DataPart { constructor(d,m){ this.data=d; this.mimeType=m; } }
class CancellationError extends Error {}
class EventEmitter { constructor(){ this.l=[]; this.event = f => { this.l.push(f); return { dispose(){} }; }; } fire(v){ this.l.forEach(f=>f(v)); } }
global.__config = global.__config || {};
module.exports = {
  LanguageModelTextPart: TextPart, LanguageModelToolCallPart: ToolCallPart, LanguageModelToolResultPart: ToolResultPart,
  LanguageModelDataPart: DataPart, LanguageModelChatMessageRole: { User: 1, Assistant: 2 }, CancellationError, EventEmitter,
  LanguageModelChatToolMode: { Auto: 1, Required: 2 },
  ProgressLocation: { Window: 10 },
  window: { withProgress: async (_o, fn) => fn({ report: m => (global.__progress = global.__progress || []).push(m.message) }),
            setStatusBarMessage: () => ({ dispose(){} }), showErrorMessage: async () => undefined, showInputBox: async () => undefined },
  commands: { executeCommand: async () => undefined },
  workspace: { getConfiguration: () => ({ get: k => global.__config[k] }) },
};
