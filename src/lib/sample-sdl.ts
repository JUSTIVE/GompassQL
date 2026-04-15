export const SAMPLE_SDL = `"""A user in the system."""
type User implements Node {
  id: ID!
  name: String!
  email: String!
  role: Role!
  posts: [Post!]!
  profile: Profile
}

type Profile {
  bio: String
  avatarUrl: String
  owner: User!
}

"""Anything that can be fetched by id."""
interface Node {
  id: ID!
}

type Post implements Node {
  id: ID!
  title: String!
  body: String!
  author: User!
  tags: [Tag!]!
  status: PostStatus!
}

type Tag {
  id: ID!
  label: String!
}

enum Role {
  ADMIN
  EDITOR
  VIEWER
}

enum PostStatus {
  DRAFT
  PUBLISHED
  ARCHIVED
}

union SearchResult = User | Post | Tag

scalar DateTime

type Query {
  me: User
  user(id: ID!): User
  posts(status: PostStatus): [Post!]!
  search(term: String!): [SearchResult!]!
}

type Mutation {
  createPost(input: CreatePostInput!): Post!
}

input CreatePostInput {
  title: String!
  body: String!
  tags: [ID!]
}
`;
