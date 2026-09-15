import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';

/** `editable=false` only blocks typing; node views and toolbar commands also need a gate. */
export function sourcePreservationExtension(canChange: () => boolean) {
  return Extension.create({
    name: 'sourcePreservation',
    addProseMirrorPlugins() {
      return [new Plugin({
        filterTransaction: transaction => !transaction.docChanged || canChange(),
      })];
    },
  });
}
