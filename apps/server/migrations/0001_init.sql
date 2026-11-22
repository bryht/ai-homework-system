-- AI Homework System schema.
-- Turns store only what is new in each request (the student's message and the full reply);
-- the conversation tree is rebuilt from chat-demo message IDs.

CREATE TABLE users (
    id            text PRIMARY KEY,
    role          text NOT NULL CHECK (role IN ('teacher', 'student')),
    name          text NOT NULL,
    username      text NOT NULL UNIQUE,
    password_hash text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- id is the SHA-256 of the cookie token, so a database leak exposes no usable sessions.
CREATE TABLE sessions (
    id         text PRIMARY KEY,
    user_id    text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE classes (
    id         text PRIMARY KEY,
    teacher_id text NOT NULL REFERENCES users (id),
    name       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE class_members (
    class_id   text NOT NULL REFERENCES classes (id) ON DELETE CASCADE,
    student_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (class_id, student_id)
);

CREATE TABLE homeworks (
    id                    text PRIMARY KEY,
    class_id              text NOT NULL REFERENCES classes (id),
    title                 text NOT NULL,
    description           text NOT NULL DEFAULT '',
    start_at              timestamptz NOT NULL,
    due_at                timestamptz NOT NULL,
    status                text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
    allow_late_submission boolean NOT NULL DEFAULT false,
    ai_config             jsonb NOT NULL,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now()
);

-- One row per chat-demo conversation; client_session_id is the browser-side session ID.
CREATE TABLE conversations (
    id                text PRIMARY KEY,
    homework_id       text NOT NULL REFERENCES homeworks (id),
    user_id           text NOT NULL REFERENCES users (id),
    client_session_id text NOT NULL,
    title             text NOT NULL DEFAULT '',
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (homework_id, user_id, client_session_id)
);

CREATE TABLE turns (
    id                  text PRIMARY KEY,
    -- insertion order, the tie-breaker when timestamps are equal
    seq                 bigint GENERATED ALWAYS AS IDENTITY,
    conversation_id     text NOT NULL REFERENCES conversations (id),
    homework_id         text NOT NULL REFERENCES homeworks (id),
    user_id             text NOT NULL REFERENCES users (id),
    kind                text NOT NULL CHECK (kind IN ('new', 'edit', 'regenerate', 'continue')),
    status              text NOT NULL CHECK (status IN ('streaming', 'ok', 'aborted', 'error')),
    user_message_id     text,
    parent_message_id   text,
    assistant_message_id text,
    user_content        jsonb NOT NULL,
    assistant_content   jsonb NOT NULL DEFAULT '[]',
    file_ids            jsonb NOT NULL DEFAULT '[]',
    model               text NOT NULL,
    request_meta        jsonb NOT NULL DEFAULT '{}',
    input_tokens        integer NOT NULL DEFAULT 0,
    output_tokens       integer NOT NULL DEFAULT 0,
    latency_ms          integer,
    stop_reason         text,
    error               text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    completed_at        timestamptz
);
CREATE INDEX turns_homework_user_idx ON turns (homework_id, user_id);
CREATE INDEX turns_conversation_idx ON turns (conversation_id);

CREATE TABLE files (
    id               text PRIMARY KEY,
    owner_id         text NOT NULL REFERENCES users (id),
    homework_id      text REFERENCES homeworks (id),
    purpose          text NOT NULL CHECK (purpose IN ('chat', 'submission')),
    filename         text NOT NULL,
    mime_type        text NOT NULL,
    size             integer NOT NULL,
    sha256           text NOT NULL,
    storage_key      text NOT NULL,
    provider         text,
    provider_file_id text,
    created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX files_homework_owner_idx ON files (homework_id, owner_id);

CREATE TABLE submissions (
    id           text PRIMARY KEY,
    homework_id  text NOT NULL REFERENCES homeworks (id),
    student_id   text NOT NULL REFERENCES users (id),
    content      text NOT NULL,
    file_ids     jsonb NOT NULL DEFAULT '[]',
    is_late      boolean NOT NULL DEFAULT false,
    submitted_at timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (homework_id, student_id)
);

-- Phase 1 only uses the teacher_* columns; metrics / ai_* are reserved for automated evaluation.
CREATE TABLE evaluations (
    id              text PRIMARY KEY,
    homework_id     text NOT NULL REFERENCES homeworks (id),
    student_id      text NOT NULL REFERENCES users (id),
    teacher_score   double precision,
    teacher_comment text NOT NULL DEFAULT '',
    graded_at       timestamptz,
    metrics         jsonb,
    ai_scores       jsonb,
    ai_summary      text,
    judge_model     text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (homework_id, student_id)
);
