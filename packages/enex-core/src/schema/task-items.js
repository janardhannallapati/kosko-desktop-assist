// Note task lists: checklists whose items are real checkboxes (Kosko 251).
//
// SCHEMA ONLY. `nested: true` is schema (it lets a task item hold a nested list). Kosko's editor adds its
// keyboard shortcut with `.extend()` in app/note-task-items.js; the tool never runs an editor.
import { TaskList, TaskItem } from '@tiptap/extension-list';

export const NoteTaskItem = TaskItem.configure({ nested: true });

export const TASK_EXTENSIONS = [TaskList, NoteTaskItem];
