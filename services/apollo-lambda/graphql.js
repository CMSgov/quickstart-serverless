const { ApolloServer, gql } = require('apollo-server-lambda');
const { unmarshall } = require("@aws-sdk/util-dynamodb");
const { DynamoDBClient, ScanCommand } = require("@aws-sdk/client-dynamodb");
const client = new DynamoDBClient({ region: "us-east-1" });
const getQuotes = async () => {
  const params = {
    TableName: "apollo-graphql-amendments",
  };
  try {
    const results = await client.send(new ScanCommand(params));
    const quotes = [];
    results.Items.forEach((item) => {
      quotes.push(unmarshall(item));
    });
    return quotes;
  } catch (err) {
    console.error(err);
    return err;
  }
};
// Construct a schema, using GraphQL schema language
const typeDefs = gql`
scalar JSON
type Quote {
  userId: ID!
  amendmentId: ID!
  firstName:    String!
  LastName:     String!
  comments:     String
  email:        string
  email:        String
  CreatedAt:    Boolean
  territory:    String
  urgent:       Boolean

}

  type Query {
    quotes: [Quote!]
    quote(userId:ID!):Quote
    quoted(amendmentId:ID!):Quote

  }
`;
// Provide resolver functions for your schema fields
const resolvers = {
  Query: {
    quotes: () => {
      return getQuotes();
    },
  },
};
const server = new ApolloServer({
  typeDefs,
  resolvers,
});
const handler = server.createHandler({
  cors: {
    origin: true,
    credentials: true,
  },
});
exports.graphqlHandler = handler;
