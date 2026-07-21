export interface GmailLabel {
  id: string;
  name: string;
}

export interface RawEmail {
  id: string;
  from: string;
  subject: string;
  date: string;
  body: string;
}

export interface EmailSummary {
  id: string;
  from: string;
  subject: string;
  date: string;
  summary: string;
}
