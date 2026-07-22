export interface Email {
  id: string;
  from: string;
  subject: string;
  body: string;
  date: string;
}

export interface Label {
  id: string;
  name: string;
}

export interface Summary {
  id: string;
  from: string;
  subject: string;
  date: string;
  summary: string;
}
