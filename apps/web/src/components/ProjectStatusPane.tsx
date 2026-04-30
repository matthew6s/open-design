import type { ChatMessage, Conversation, Project, ProjectFile } from '../types';

interface Props {
  project: Project;
  conversations: Conversation[];
  activeConversationId: string | null;
  messages: ChatMessage[];
  files: ProjectFile[];
  streaming: boolean;
  error: string | null;
}

export function ProjectStatusPane({ project, conversations, messages, files }: Props) {
  return (
    <div className="pane project-status-pane">
      <div className="project-status-header">
        <span className="project-status-title">{project.name}</span>
      </div>
      <div className="project-status-body">
        <div className="project-status-row">
          <span className="project-status-label">Conversations</span>
          <span className="project-status-value">{conversations.length}</span>
        </div>
        <div className="project-status-row">
          <span className="project-status-label">Messages</span>
          <span className="project-status-value">{messages.length}</span>
        </div>
        <div className="project-status-row">
          <span className="project-status-label">Files</span>
          <span className="project-status-value">{files.length}</span>
        </div>
      </div>
    </div>
  );
}
