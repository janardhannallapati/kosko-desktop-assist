-- Evernote 10's local database (UDB-User<id>+RemoteGraph.sql): the eight tables the reader touches, copied
-- verbatim from sqlite_master on 2026-10-04 (major_database_version 3, migration_version 139). Schema only;
-- the synthetic test database is built from it. The real file has ~180 tables; the reader needs these.

CREATE TABLE _DBMetadata(
`id` TEXT PRIMARY KEY,
`version` INTEGER NOT NULL);

CREATE TABLE Nodes_Notebook(
`id` TEXT PRIMARY KEY,
`created` INTEGER NOT NULL,
`updated` INTEGER NOT NULL,
`isPublished` BOOLEAN NOT NULL,
`inWorkspace` BOOLEAN NOT NULL,
`isExternal` BOOLEAN NOT NULL,
`isShared` BOOLEAN NOT NULL,
`reminderNotifyEmail` BOOLEAN NOT NULL,
`reminderNotifyInApp` BOOLEAN NOT NULL,
`internal_shareCountProfiles` TEXT NOT NULL,
`parent_Workspace_id` TEXT,
`personal_Stack_id` TEXT,
`_input_edges` TEXT,
`label` TEXT NOT NULL,
`localChangeTimestamp` REAL NOT NULL,
`_output_edges` TEXT,
`creator_Profile_id` TEXT,
`owner` REAL,
`shardId` TEXT,
`_undefinedNodeFields` TEXT,
`version` REAL NOT NULL,
`__unknownFields` TEXT,
`markedForOffline` INTEGER NOT NULL DEFAULT 0,
`recipient_Stack_id` TEXT,
`stack_Stack_id` TEXT GENERATED ALWAYS AS (COALESCE(personal_Stack_id, recipient_Stack_id)) VIRTUAL);

CREATE TABLE Nodes_Tag(
`id` TEXT PRIMARY KEY,
`_input_edges` TEXT,
`parent_Tag_id` TEXT,
`label` TEXT NOT NULL,
`localChangeTimestamp` REAL NOT NULL,
`_output_edges` TEXT,
`owner` REAL,
`shardId` TEXT,
`_undefinedNodeFields` TEXT,
`version` REAL NOT NULL,
`__unknownFields` TEXT,
`noteCount` INTEGER NOT NULL DEFAULT 0);

CREATE TABLE Nodes_Note(
`id` TEXT PRIMARY KEY,
`isMetadata` BOOLEAN NOT NULL,
`isUntitled` BOOLEAN NOT NULL,
`created` INTEGER NOT NULL,
`updated` INTEGER NOT NULL,
`deleted` INTEGER,
`isExternal` BOOLEAN NOT NULL,
`content_localChangeTimestamp` INTEGER NOT NULL,
`content_hash` TEXT NOT NULL,
`content_size` REAL NOT NULL,
`snippet` TEXT,
`attributes_subjectDate` INTEGER,
`attributes_contentClass` TEXT,
`reminder_order` INTEGER,
`reminder_doneTime` INTEGER,
`reminder_time` INTEGER,
`share_date` INTEGER,
`share_publishingPrivilege` INTEGER,
`editor_author` TEXT,
`editor_lastEditedBy` TEXT,
`source` TEXT,
`source_URL` TEXT,
`source_application` TEXT,
`noteResourceCountMax` REAL,
`uploadLimit` REAL,
`resourceSizeMax` REAL,
`noteSizeMax` REAL,
`uploaded` REAL,
`parent_Notebook_id` TEXT,
`parent_Workspace_id` TEXT,
`internal_shareCountProfiles` TEXT NOT NULL,
`internal_maxResourceVersion` REAL NOT NULL,
`internal_resourcesChanged` BOOLEAN NOT NULL,
`internal_contentChanged` BOOLEAN NOT NULL,
`internal_activeResourceCount` REAL NOT NULL,
`isTemplate` BOOLEAN,
`selectedThumbnailHash` TEXT,
`_input_edges` TEXT,
`label` TEXT NOT NULL,
`localChangeTimestamp` REAL NOT NULL,
`_output_edges` TEXT,
`creator_Profile_id` TEXT,
`lastEditor_Profile_id` TEXT,
`owner` REAL,
`shardId` TEXT,
`_undefinedNodeFields` TEXT,
`version` REAL NOT NULL,
`__unknownFields` TEXT,
`markedForOffline` INTEGER NOT NULL DEFAULT 0,
`localContentHash` TEXT,
`parentMarkedForOffline` INTEGER NOT NULL DEFAULT 0,
`attachmentsToDownloadCount` INTEGER NOT NULL DEFAULT 0,
`contentDownloaded` INTEGER NOT NULL GENERATED ALWAYS AS (localContentHash IS content_hash) VIRTUAL, flaggedAsMalicious BOOLEAN);

CREATE TABLE NoteTag(
`id` TEXT PRIMARY KEY,
`Note_id` TEXT NOT NULL,
`Tag_id` TEXT NOT NULL);

CREATE TABLE Attachment(
  `id` TEXT PRIMARY KEY,
  `filename` TEXT NOT NULL,
  `mime` TEXT NOT NULL,
  `width` INTEGER NOT NULL,
  `height` INTEGER NOT NULL,
  `isActive` BOOLEAN NOT NULL,
  `dataHash` TEXT NOT NULL,
  `dataSize` INTEGER NOT NULL,
  `recognitionHash` TEXT,
  `recognitionSize` INTEGER,
  `applicationDataKeys` TEXT NOT NULL,
  `localFileUrl` TEXT,
  `owner` INTEGER NOT NULL,
  `shardId` TEXT NOT NULL,
  `version` INTEGER NOT NULL,
  `unknownFields` TEXT,
  `parent_Note_id` TEXT NOT NULL,
  `isDownloadedLocally` INTEGER NOT NULL DEFAULT 0,
  `localRecognitionHash` TEXT,
  `localRecognitionDownloaded` INTEGER NOT NULL GENERATED ALWAYS AS (recognitionHash is NULL OR localRecognitionHash IS recognitionHash) VIRTUAL, applicationData TEXT);

CREATE TABLE "AttachmentRecognition"(
`id` TEXT PRIMARY KEY,
`content` TEXT NOT NULL);

CREATE TABLE Offline_Search_Note_Content(
`id` TEXT PRIMARY KEY,
`content` TEXT NOT NULL);
