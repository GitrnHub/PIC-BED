CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  source_type TEXT NOT NULL CHECK (source_type IN ('local', 'url')),
  source_url TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  max_downloads INTEGER CHECK (max_downloads IS NULL OR max_downloads > 0),
  download_count INTEGER NOT NULL DEFAULT 0 CHECK (download_count >= 0),
  status TEXT NOT NULL CHECK (
    status IN ('uploading', 'active', 'expired', 'exhausted', 'deleted', 'failed')
  ),
  created_by TEXT NOT NULL DEFAULT 'admin',
  last_download_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_files_status ON files(status);
CREATE INDEX IF NOT EXISTS idx_files_expires_at ON files(expires_at);


