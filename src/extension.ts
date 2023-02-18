import * as vscode from "vscode";
import { Configuration, OpenAIApi } from "openai";

export function activate(context: vscode.ExtensionContext) {
  let disposable = vscode.commands.registerCommand(
    "haikufy.generateHaiku",
    async () => {
      const openAiApiKey = vscode.workspace
        .getConfiguration("haikufy")
        .get<string>("openAiApiKey");

      if (!openAiApiKey) {
        vscode.window
          .showWarningMessage(
            "Unable to generate Haiku due to missing OpenAI API key",
            "Add API key",
            "Cancel"
          )
          .then((selection) => {
            switch (selection) {
              case "Add API key":
                vscode.commands.executeCommand(
                  "workbench.action.openSettings",
                  "haikufy"
                );
            }
          });
        return;
      }

      const editor = vscode.window.activeTextEditor;
      const selections = editor?.selections;
      if (!selections) {
        vscode.window.showWarningMessage(
          "No code selected! Select some code to generate an Haiku!"
        );
        return;
      }

      const openai = new OpenAIApi(
        new Configuration({
          apiKey: openAiApiKey,
        })
      );

      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Generating Haiku comments...",
        },
        () =>
          Promise.allSettled(
            selections.map((selection) =>
              replaceSelection(selection, editor, openai)
            )
          ).then((results) => {
            const fullfilledPromises = results.filter(
              (r): r is PromiseFulfilledResult<[vscode.Position, string]> =>
                r.status === "fulfilled"
            );
            // Batch edit to allow multiselection
            editor.edit((editBuilder) =>
              fullfilledPromises
                .map(({ value }) => value)
                .forEach(([position, text]) =>
                  editBuilder.insert(position, text)
                )
            );
            if (fullfilledPromises.length !== results.length) {
              const rejectedPromise = results.find(
                (r): r is PromiseRejectedResult => r.status === "rejected"
              );
              vscode.window.showErrorMessage(
                `Error while accessing OpenAI API: ${rejectedPromise!.reason}`
              );
            }
          })
      );
    }
  );

  context.subscriptions.push(disposable);
}

async function replaceSelection(
  selection: vscode.Selection,
  editor: vscode.TextEditor,
  openAi: OpenAIApi
): Promise<[vscode.Position, string]> {
  if (selection.isEmpty) {
    return [selection.start, ""];
  }

  // Sorts the lines since anchor and active can be in any order.
  const sortedLines = [selection.anchor.line, selection.active.line].sort(
    (a, b) => a - b
  );
  const selectionFullLineStart = new vscode.Position(sortedLines[0], 0);
  const selectionFullLineEnd = new vscode.Position(
    sortedLines[1],
    editor.document.lineAt(sortedLines[1]).text.length
  );
  const fullLinesSelection = new vscode.Selection(
    selectionFullLineStart,
    selectionFullLineEnd
  );
  const code = editor.document.getText(fullLinesSelection);
  const prompt = `Given a code fragment, generate a multiline comment that explains it.
   The generated comment must be an haiku. The output must be a valid JSON with an "haiku"
   array field that contains the 3 haiku lines, a "beginComment" field which contains the
   characters to begin a multi-line comment with in the given code language and a "endComment" field which
   contains the characters to end a multi-line comment with in the given code language.
   The JSON keys and values must be properly quoted. 
   The code is the following: \n ${code} \n The valid JSON output is the following:`;

  // Stops at closed bracket to avoid other text breaking JSON parsing.
  const completion = await openAi.createCompletion({
    model: "text-davinci-003",
    prompt,
    max_tokens: 256,
    stop: "}",
  });
  const openAiResponse = completion.data.choices[0].text || "{}";
  const { haiku, beginComment, endComment } = JSON.parse(openAiResponse + "}");

  // Safe guard in case openAI returns a single line comment instead of a multiline one
  const responseToString =
    beginComment +
    haiku.join(`${endComment}\n${beginComment}`) +
    endComment +
    "\n";

  // Writes the comment always at the top.
  const firstLine =
    selectionFullLineEnd.line > selectionFullLineStart.line
      ? selectionFullLineStart
      : selectionFullLineEnd;

  return [firstLine, responseToString];
}

export function deactivate() {}
