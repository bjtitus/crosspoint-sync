-- A book's language (BCP 47 tag, e.g. "ja" or "de-DE"), from the reader's EPUB metadata or set by hand.
ALTER TABLE documents ADD COLUMN language TEXT;
