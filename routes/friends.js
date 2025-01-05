// routes/friends.js
const express = require('express');
const router = express.Router();
const User = require('../models/User');
const auth = require('../middleware/auth');

// Get all friends
router.get('/', auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId).populate('friends');
    const friends = user.friends;
    res.json(friends);
  } catch (error) {
    console.error('Error fetching friends:', error.message);
    res.status(500).json({ message: 'Error fetching friends' });
  }
});

// Search users with autocomplete
router.get('/search', auth, async (req, res) => {
  try {
    const searchTerm = req.query.username;
    if (!searchTerm) {
      return res.json([]);
    }

    const currentUser = await User.findById(req.userId);
    const users = await User.find({
      username: { $regex: `^${searchTerm}`, $options: 'i' },
      _id: { $ne: req.userId }
    })
    .select('-password')
    .limit(10);

    const enhancedUsers = users.map(user => ({
      ...user.toObject(),
      requestStatus: currentUser.sentFriendRequests.includes(user._id) ? 'requested' : 
                    currentUser.friends.includes(user._id) ? 'friend' : 'none'
    }));
    
    res.json(enhancedUsers);
  } catch (error) {
    res.status(500).json({ message: 'Error searching users' });
  }
});

// Get pending friend requests 
router.get('/pending', auth, async (req, res) => { 
  try { 
    const user = await User.findById(req.userId).populate('pendingFriendRequests'); 
    const pendingRequests = user.pendingFriendRequests; 
    res.json(pendingRequests); 
  } catch (error) { 
    console.error('Error fetching pending friend requests:', error.message); 
    res.status(500).json({ message: 'Error fetching pending friend requests' }); 
  } 
});

// Send friend request
router.post('/request/:userId', auth, async (req, res) => {
  try {
    const sender = await User.findById(req.userId);
    const receiver = await User.findById(req.params.userId);

    if (!receiver) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (sender.friends.includes(receiver._id)) {
      return res.status(400).json({ message: 'Already friends' });
    }

    // Check if request already exists
    const existingRequest = sender.sentFriendRequests.includes(receiver._id);
    if (existingRequest) {
      // Cancel request
      sender.sentFriendRequests = sender.sentFriendRequests.filter(
        id => id.toString() !== receiver._id.toString()
      );
      receiver.pendingFriendRequests = receiver.pendingFriendRequests.filter(
        id => id.toString() !== sender._id.toString()
      );
      
      await sender.save();
      await receiver.save();
      
      return res.json({ message: 'Friend request cancelled', status: 'cancelled' });
    }

    // Send new request
    receiver.pendingFriendRequests.push(sender._id);
    sender.sentFriendRequests.push(receiver._id);
    
    await receiver.save();
    await sender.save();

    res.json({ message: 'Friend request sent', status: 'requested' });
  } catch (error) {
    res.status(500).json({ message: 'Error managing friend request' });
  }
});


// Accept friend request
router.post('/accept/:userId', auth, async (req, res) => {
  try {
    const receiver = await User.findById(req.userId);
    const sender = await User.findById(req.params.userId);

    if (!sender) {
      return res.status(404).json({ message: 'User not found' });
    }

    receiver.pendingFriendRequests = receiver.pendingFriendRequests.filter(
      id => id.toString() !== sender._id.toString()
    );
    sender.sentFriendRequests = sender.sentFriendRequests.filter(
      id => id.toString() !== receiver._id.toString()
    );

    receiver.friends.push(sender._id);
    sender.friends.push(receiver._id);

    await receiver.save();
    await sender.save();

    res.json({ message: 'Friend request accepted' });
  } catch (error) {
    res.status(500).json({ message: 'Error accepting friend request' });
  }
});

// Get friend recommendations
router.get('/recommendations', auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId)
      .populate('friends')
      .populate('sentFriendRequests')
      .populate('pendingFriendRequests');

    const friendIds = user.friends.map(friend => friend._id.toString());
    const sentRequestIds = user.sentFriendRequests.map(req => req._id.toString());
    const pendingRequestIds = user.pendingFriendRequests.map(req => req._id.toString());
    const excludeIds = [...friendIds, ...sentRequestIds, ...pendingRequestIds, user._id.toString()];

    // First, get users with similar interests
    let similarInterestsUsers = [];
    if (user.interests && user.interests.length > 0) {
      similarInterestsUsers = await User.find({
        _id: { $nin: excludeIds },
        interests: { $in: user.interests }
      }).populate('friends');
    }

    // Then, get users with mutual friends
    let mutualFriendsUsers = [];
    if (friendIds.length > 0) {
      mutualFriendsUsers = await User.find({
        _id: { $nin: excludeIds }
      }).populate('friends');

      // Filter users who actually have mutual friends
      mutualFriendsUsers = mutualFriendsUsers.filter(potentialFriend => {
        const mutualFriendsCount = potentialFriend.friends
          .filter(friend => friendIds.includes(friend._id.toString()))
          .length;
        return mutualFriendsCount > 0;
      });
    }

    // Combine and calculate scores
    const allPotentialUsers = [...new Set([...similarInterestsUsers, ...mutualFriendsUsers])];
    
    const recommendations = allPotentialUsers
      .map(potential => {
        const mutualFriends = potential.friends
          .filter(friend => friendIds.includes(friend._id.toString()))
          .length;

        const mutualInterests = user.interests
          .filter(interest => potential.interests.includes(interest))
          .length;

        return {
          user: potential,
          mutualFriends,
          mutualInterests,
          score: (mutualFriends * 2) + mutualInterests
        };
      })
      .filter(rec => rec.score > 0) // Only include recommendations with some connection
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    res.json(recommendations);
  } catch (error) {
    console.error('Error getting recommendations:', error);
    res.status(500).json({ message: 'Error getting recommendations' });
  }
});


// Unfriend user
router.post('/unfriend/:userId', auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    const friend = await User.findById(req.params.userId);

    if (!friend) {
      return res.status(404).json({ message: 'User not found' });
    }

    user.friends = user.friends.filter(id => id.toString() !== friend._id.toString());
    friend.friends = friend.friends.filter(id => id.toString() !== user._id.toString());

    await user.save();
    await friend.save();

    res.json({ message: 'Friend removed' });
  } catch (error) {
    res.status(500).json({ message: 'Error removing friend' });
  }
});

module.exports = router;