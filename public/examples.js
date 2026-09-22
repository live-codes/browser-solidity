/** Starter programs. `contract` / `fn` / `args` preselect what the editor runs. */
export default [
  {
    name: 'Hello, World',
    contract: 'Hello',
    fn: 'greet()',
    args: [],
    source: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract Hello {
    function greet() public pure returns (string memory message) {
        return "Hello from Solidity, compiled and run in your browser.";
    }
}
`,
  },
  {
    name: 'Counter (storage)',
    contract: 'Counter',
    fn: 'increment()',
    args: [],
    source: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract Counter {
    uint256 public count;

    function increment() public {
        count += 1;
    }

    function current() public view returns (uint256) {
        return count;
    }
}
`,
  },
  {
    name: 'Events',
    contract: 'Token',
    fn: 'transfer(address,uint256)',
    args: ['0x000000000000000000000000000000000000dEaD', '1000'],
    source: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract Token {
    event Transfer(address indexed from, address indexed to, uint256 value);

    mapping(address => uint256) public balanceOf;

    constructor() {
        balanceOf[msg.sender] = 1000;
    }

    function transfer(address to, uint256 value) public returns (bool ok) {
        require(balanceOf[msg.sender] >= value, "insufficient balance");
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        emit Transfer(msg.sender, to, value);
        return true;
    }
}
`,
  },
  {
    name: 'Revert with a reason',
    contract: 'Vault',
    fn: 'withdraw(uint256)',
    args: ['1'],
    source: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract Vault {
    mapping(address => uint256) public balanceOf;

    function deposit() public payable {
        balanceOf[msg.sender] += msg.value;
    }

    function withdraw(uint256 amount) public {
        require(balanceOf[msg.sender] >= amount, "insufficient balance");
        balanceOf[msg.sender] -= amount;
    }
}
`,
  },
  {
    name: 'Custom error',
    contract: 'Guarded',
    fn: 'restricted()',
    args: [],
    source: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract Guarded {
    error Unauthorized(address caller);

    address public constant OWNER = 0xBEEF00000000000000000000000000000000BEEf;

    function restricted() public view {
        if (msg.sender != OWNER) revert Unauthorized(msg.sender);
    }
}
`,
  },
  {
    name: 'Structs and loops',
    contract: 'Inventory',
    fn: 'add(string,uint256)',
    args: ['widget', '5'],
    source: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract Inventory {
    struct Item {
        string name;
        uint256 qty;
    }

    Item[] private items;

    function add(string memory name, uint256 qty) public {
        items.push(Item(name, qty));
    }

    function all() public view returns (Item[] memory list) {
        return items;
    }

    function total() public view returns (uint256 sum) {
        for (uint256 i = 0; i < items.length; i++) {
            sum += items[i].qty;
        }
    }
}
`,
  },
];
