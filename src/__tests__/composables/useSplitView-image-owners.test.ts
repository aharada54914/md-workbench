import { describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import { getTabImageOwner, useSplitView } from '../../composables/useSplitView';
import { documentImageBytes } from '../../services/documentImageBytes';

describe('live tab image ownership', () => {
  it('survives pane moves and Save As, but close and reused tab IDs do not revive bytes', () => {
    const split = useSplitView();
    const id = split.createTab('left');
    const tab = split.leftPane.value.tabs.find(t => t.id === id)!;
    const owner = getTabImageOwner(tab)!;
    documentImageBytes.reserve(owner, 1).prepare('/x.png', new Uint8Array([1])).commit();
    tab.filePath = '/saved.md';
    expect(getTabImageOwner(tab)).toBe(owner);
    split.enableSplit();
    split.moveTabBetweenPanes({ tabId: id, sourcePaneId: 'left', targetPaneId: 'right' });
    expect(getTabImageOwner(tab)).toBe(owner);
    const pane = split.splitState.value.panes.find(p => p.tabs.includes(tab))!;
    split.closeTab(pane.id, id);
    expect(documentImageBytes.isCurrent(owner)).toBe(false);
    expect(getTabImageOwner(tab)).toBeUndefined();
    const nextId = split.createTab('left');
    const next = split.leftPane.value.tabs.find(t => t.id === nextId)!;
    next.id = id;
    expect(getTabImageOwner(next)).not.toBe(owner);
    expect(documentImageBytes.read(getTabImageOwner(next)!, '/x.png')).toBeUndefined();
    split.closeTab('left', id);
  });

  it('cleans owners on whole-state tab replacement after the synchronous move window', async () => {
    const split = useSplitView();
    const id = split.createTab('left');
    const tab = split.leftPane.value.tabs.find(t => t.id === id)!;
    const owner = getTabImageOwner(tab)!;
    split.leftPane.value.tabs = split.leftPane.value.tabs.filter(t => t !== tab);
    await nextTick();
    expect(documentImageBytes.isCurrent(owner)).toBe(false);
    expect(getTabImageOwner(tab)).toBeUndefined();
  });
});
