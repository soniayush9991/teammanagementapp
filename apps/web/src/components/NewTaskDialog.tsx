import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { TASK_PRIORITIES, type Task, type TaskPriority } from '@teamspace/shared';
import { api, ApiError } from '../api/client';
import { Button, Field, Input, Modal, Select, Textarea } from './ui';
import { useToast } from '../state/ToastContext';
import { useAuth } from '../state/AuthContext';

interface TeamMember {
  userId: string;
  displayName: string;
}

export function NewTaskDialog({ teamId, onClose }: { teamId: string; onClose: () => void }): JSX.Element {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const { can } = useAuth();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('medium');
  const [dueDate, setDueDate] = useState('');
  const [estimatedHours, setEstimatedHours] = useState('4');
  const [assigneeId, setAssigneeId] = useState('');
  const [labels, setLabels] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { data: members } = useQuery({
    queryKey: ['team-members', teamId],
    queryFn: () => api.get<{ items: TeamMember[] }>(`/teams/${teamId}/members`).then((r) => r.items),
  });

  const create = useMutation({
    mutationFn: (): Promise<Task> =>
      api.post<Task>('/tasks', {
        teamId,
        title: title.trim(),
        description: description.trim() || undefined,
        priority,
        dueDate: dueDate || null,
        estimatedHours: Number(estimatedHours) || 0,
        assigneeIds: assigneeId ? [assigneeId] : undefined,
        labels: labels
          .split(',')
          .map((label) => label.trim())
          .filter(Boolean),
      }),
    onSuccess: (task) => {
      notify(`${task.key} created`, 'success');
      void queryClient.invalidateQueries({ queryKey: ['board'] });
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
      void queryClient.invalidateQueries({ queryKey: ['capacity'] });
      onClose();
    },
    onError: (caught) => {
      setError(caught instanceof ApiError ? caught.message : 'The task could not be created');
    },
  });

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    if (title.trim().length === 0) {
      setError('Give the task a title');
      return;
    }
    setError(null);
    create.mutate();
  };

  return (
    <Modal
      title="New task"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => onSubmit(new Event('submit') as unknown as FormEvent)} disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create task'}
          </Button>
        </>
      }
    >
      <form onSubmit={onSubmit}>
        <Field label="Title" htmlFor="task-title" error={error ?? undefined}>
          <Input
            id="task-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            required
            autoFocus
            maxLength={300}
          />
        </Field>

        <Field label="Description" htmlFor="task-description" hint="Markdown is not rendered; keep it plain and short.">
          <Textarea
            id="task-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={3}
          />
        </Field>

        <div className="row" style={{ gap: 'var(--space-4)', alignItems: 'flex-start' }}>
          <Field label="Priority" htmlFor="task-priority">
            <Select
              id="task-priority"
              value={priority}
              onChange={(event) => setPriority(event.target.value as TaskPriority)}
            >
              {TASK_PRIORITIES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Due date" htmlFor="task-due">
            <Input id="task-due" type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} />
          </Field>

          <Field label="Estimate (hours)" htmlFor="task-estimate">
            <Input
              id="task-estimate"
              type="number"
              min={0}
              max={999}
              step={0.5}
              value={estimatedHours}
              onChange={(event) => setEstimatedHours(event.target.value)}
            />
          </Field>
        </div>

        {can('task:assign') && (
          <Field label="Assign to" htmlFor="task-assignee" hint="Leave empty to triage it later.">
            <Select id="task-assignee" value={assigneeId} onChange={(event) => setAssigneeId(event.target.value)}>
              <option value="">Unassigned</option>
              {(members ?? []).map((member) => (
                <option key={member.userId} value={member.userId}>
                  {member.displayName}
                </option>
              ))}
            </Select>
          </Field>
        )}

        <Field label="Labels" htmlFor="task-labels" hint="Comma separated. Labels double as skill hints for assignment suggestions.">
          <Input id="task-labels" value={labels} onChange={(event) => setLabels(event.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}
