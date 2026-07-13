export interface TerminalLine {
  id: string;
  type: 'input' | 'continuation' | 'label' | 'info' | 'output' | 'error';
  content: string;
  ariaLabel?: string;
}

export interface DemoScenario {
  id: string;
  title: string;
  description: string;
  filename: string;
  fileContent: string;
  command: string;
  outputMock: TerminalLine[];
}

export enum StepStatus {
  IDLE = 'idle',
  RUNNING = 'running',
  COMPLETE = 'complete'
}