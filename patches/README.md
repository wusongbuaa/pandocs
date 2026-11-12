# Patches to dependencies

## micromark-util-edit-map

`EditMap.consume` copied the whole list of events each time it applied an edit, even though edits only touch the end of it. The Markdown parser applies one each time a list or quote ends, so parsing took time in proportion to the square of the page's length: a 700 KB page of short lists took 39 seconds, and memory ran out on a 1 MB page in a 1 GB container. Leaving the start of the list where it is gives the same result in about a second.

Remove the patch once the package does this itself. `packages/markdown/test/editing.test.ts` fails if it comes back.

## @tiptap/extension-list

The editor reads a numbered list with its own tokenizer, which took a step's content to start one column early: it counted the number and the space after it, but not the dot. Every line under `1. ` kept one space too many, and then only the first of them lost it, so the second and third of three checkboxes under a step came out as children of the first. Opening the page in the editor showed them that way, and saving the list wrote that down. The patch takes the content's column from where it actually starts, and removes the indentation the lines share rather than the first line's alone.

Remove the patch once the package does both itself. `packages/editor-model/test/live.test.ts` fails if either comes back.
